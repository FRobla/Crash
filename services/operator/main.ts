import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { isTerminalPhase, type RoundAccount } from "@/chain-adapters/solana/crash-program/accounts";
import { CRASH_PROGRAM_ID } from "@/chain-adapters/solana/crash-program/deployment";
import {
  closeBettingIx,
  forfeitRoundIx,
  openRoundIx,
  revealIx,
  settleBetIx,
  startRoundIx,
  voidRoundIx,
} from "@/chain-adapters/solana/crash-program/instructions";
import { DEVNET_GENESIS_HASH } from "@/chain-adapters/solana/config";
import { SWITCHBOARD_PROGRAM_ID, revealSideAccounts } from "@/chain-adapters/solana/switchboard/accounts";
import { fetchRevealPayload } from "@/chain-adapters/solana/switchboard/gateway";
import { rankOracles } from "@/chain-adapters/solana/switchboard/oracle-selection";
import { computeCommitment } from "@/games/crash/fairness/verify-round";
import { SlotClock } from "@/chain-adapters/solana/network/slot-clock";
import { OperatorChain, type SendResult } from "./chain";
import { parseOperatorConfig } from "./config";
import { DISABLED_FEED, FEED_PATH, SseLiveFeed, type LiveFeed } from "./live-feed";
import { createLogger } from "./logger";
import { SETTLE_MARGIN_SLOTS, planNextAction, settleWindowOpen, type CrankAction } from "./plan";
import { expectedCrash, seedMatchesCommit } from "./round-math";
import { createFileSeedStore, type SeedStore } from "./seed-store";

/**
 * Operator crank (docs/specs/crash-client-v1.md §4). One loop: read the chain, plan one action,
 * execute it, repeat. All state that matters lives on-chain or in the seed store, so the process
 * can be stopped and restarted at any point.
 */

const SETTLEMENTS_PER_TRANSACTION = 4;
/** Slot-targeted waits: sleep until this close to the target, then poll the slot. */
const FINAL_APPROACH_MS = 1_500;
const SLOT_POLL_MS = 500;
const MAX_SLEEP_MS = 10_000;
const MIN_OPERATOR_LAMPORTS = 50_000_000n;

const log = createLogger();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function loadKeypair(path: string): Keypair {
  const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("operator keypair file is not a 64-byte array");
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

class Crank {
  private readonly programIdBytes = CRASH_PROGRAM_ID.toBytes();
  /** Oracles that failed a commit, per round, so a retry picks another one. */
  private readonly failedOracles = new Map<bigint, Set<string>>();
  private lastRoundEndedAt = 0;
  /** Round whose betting window already ran the settlement pass. */
  private settledDuring: bigint | null = null;
  private stopping = false;
  private readonly clock = new SlotClock();

  constructor(
    private readonly chain: OperatorChain,
    private readonly seeds: SeedStore,
    private readonly feed: LiveFeed,
    private readonly pauseMs: number,
    private readonly pollMs: number,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  async calibrate(): Promise<void> {
    const measured = await this.chain.measuredMsPerSlot();
    if (measured !== null) this.clock.setBaseline(measured);
    log.info("slot-clock", { msPerSlot: Math.round(this.clock.msPerSlot()) });
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.step();
      } catch (error) {
        log.error("step-failed", { error: error instanceof Error ? error.message : String(error) });
        await sleep(this.pollMs * 2);
      }
    }
    log.info("stopped", {});
  }

  private async step(): Promise<void> {
    const { config, round, slot } = await this.chain.snapshot();
    this.clock.observe(slot, Date.now());
    let hasSeed = false;
    let crashTick: bigint | null = null;
    if (round) {
      const seed = this.seeds.read(round.roundId);
      hasSeed = seed !== null && (await seedMatchesCommit(this.programIdBytes, round.roundId, seed, round.commit));
      if (hasSeed && round.phase === "Running") {
        crashTick = (await expectedCrash(this.programIdBytes, round.roundId, round.rulesVersion, seed!, round.vrfOutput))
          .crashTick;
      }
    }

    const action = planNextAction({ config, round, slot, hasSeed, crashTick });
    if (action.kind === "open") {
      // The next round opens first; settlements run during its betting window (spec §4.2).
      const waitMs = this.lastRoundEndedAt + this.pauseMs - Date.now();
      if (waitMs > 0) return sleep(Math.min(waitMs, this.pollMs));
    }
    if (action.kind === "wait" && round && hasSeed && settleWindowOpen(round, slot) && this.settledDuring !== round.roundId) {
      this.settledDuring = round.roundId;
      const stopAt = Date.now() + Number(round.bettingEndSlot - SETTLE_MARGIN_SLOTS - slot) * this.clock.msPerSlot();
      await this.settlePending(stopAt);
      return;
    }
    await this.execute(action, round, slot);
  }

  /**
   * Sleeps until the slot is due at the measured rate, then polls `getSlot` every 500 ms only for
   * the last ≈ 1.5 s: close to the target without hammering a rate-limited RPC.
   */
  private async waitForSlot(untilSlot: bigint | null, slot: bigint): Promise<void> {
    if (untilSlot === null) return sleep(this.pollMs);
    const remainingMs = Number(untilSlot - slot) * this.clock.msPerSlot();
    if (remainingMs > FINAL_APPROACH_MS) return sleep(Math.min(remainingMs - FINAL_APPROACH_MS, MAX_SLEEP_MS));
    const giveUpAt = Date.now() + FINAL_APPROACH_MS * 2;
    while (!this.stopping && Date.now() < giveUpAt) {
      const current = await this.chain.slot();
      this.clock.observe(current, Date.now());
      if (current >= untilSlot) return;
      await sleep(SLOT_POLL_MS);
    }
  }

  private async execute(action: CrankAction, round: RoundAccount | null, slot: bigint): Promise<void> {
    const pid = CRASH_PROGRAM_ID;
    const operator = this.chain.operator.publicKey;
    switch (action.kind) {
      case "wait":
        return this.waitForSlot(action.untilSlot, slot);
      case "open": {
        const seed = this.seeds.getOrCreate(action.roundId, () => new Uint8Array(randomBytes(32)));
        const commit = await computeCommitment(this.programIdBytes, action.roundId, seed);
        const result = await this.chain.send([openRoundIx(pid, operator, action.roundId, commit)]);
        this.report(action, result);
        if (result.ok) this.feed.phase(action.roundId, "opened");
        return;
      }
      case "close-betting":
        return this.closeBetting(action.roundId);
      case "start":
        return this.start(round!);
      case "reveal": {
        const seed = this.seeds.read(action.roundId)!;
        // The seed reaches the live feed only after the reveal passed preflight (ADR 0004).
        const result = await this.chain.send([revealIx(pid, action.roundId, seed)], {
          onSubmitted: () => this.feed.crashed(action.roundId, seed),
        });
        this.report(action, result);
        if (result.ok) {
          this.feed.phase(action.roundId, "revealed");
          await this.afterReveal(action.roundId, seed, round!);
        }
        return;
      }
      case "void": {
        const result = await this.chain.send([voidRoundIx(pid, operator, action.roundId)]);
        this.report(action, result);
        if (result.ok) {
          this.feed.phase(action.roundId, "voided");
          this.endRound(action.roundId);
        }
        return;
      }
      case "forfeit": {
        const result = await this.chain.send([forfeitRoundIx(pid, action.roundId)]);
        this.report(action, result);
        if (result.ok) {
          this.feed.phase(action.roundId, "forfeited");
          this.endRound(action.roundId);
        }
        return;
      }
    }
  }

  private async closeBetting(roundId: bigint): Promise<void> {
    const { config } = await this.chain.snapshot();
    const sb = await this.chain.switchboard(config.randomnessAccount);
    const failed = this.failedOracles.get(roundId) ?? new Set<string>();
    let [oracle] = rankOracles(sb.oracles, sb.randomness.queue, sb.queue, sb.nowUnix, failed);
    if (!oracle) {
      // Every eligible oracle failed once: start over rather than give up before the timeout.
      failed.clear();
      [oracle] = rankOracles(sb.oracles, sb.randomness.queue, sb.queue, sb.nowUnix);
    }
    if (!oracle) {
      log.warn("no-eligible-oracle", { roundId: String(roundId) });
      return sleep(this.pollMs * 2);
    }
    const result = await this.chain.send([
      closeBettingIx(CRASH_PROGRAM_ID, roundId, {
        randomness: config.randomnessAccount,
        queue: sb.randomness.queue,
        oracle: oracle.key,
        switchboardProgram: SWITCHBOARD_PROGRAM_ID,
      }),
    ]);
    this.report({ kind: "close-betting", roundId }, result, { oracle: oracle.key.toBase58() });
    if (result.ok) this.feed.phase(roundId, "betting-closed");
    else {
      failed.add(oracle.key.toBase58());
      this.failedOracles.set(roundId, failed);
    }
  }

  private async start(round: RoundAccount): Promise<void> {
    const randomness = await this.chain.randomness(round.randomnessAccount);
    if (randomness.seedSlot !== round.randomnessSeedSlot) {
      log.warn("randomness-slot-mismatch", { roundId: String(round.roundId) });
      return sleep(this.pollMs);
    }
    const oracle = await this.chain.oracle(randomness.oracle);
    let payload;
    try {
      payload = await fetchRevealPayload(oracle.gatewayUri, {
        randomness: round.randomnessAccount,
        seedSlothash: randomness.seedSlothash,
        seedSlot: randomness.seedSlot,
      });
    } catch (error) {
      log.warn("gateway-unavailable", {
        roundId: String(round.roundId),
        oracle: randomness.oracle.toBase58(),
        error: error instanceof Error ? error.message : String(error),
      });
      return sleep(this.pollMs * 2);
    }
    const result = await this.chain.send([
      startRoundIx(
        CRASH_PROGRAM_ID,
        this.chain.operator.publicKey,
        round.roundId,
        {
          randomness: round.randomnessAccount,
          oracle: randomness.oracle,
          queue: randomness.queue,
          switchboardProgram: SWITCHBOARD_PROGRAM_ID,
          ...revealSideAccounts(round.randomnessAccount, randomness.oracle),
        },
        payload,
      ),
    ]);
    this.report({ kind: "start", roundId: round.roundId }, result);
    if (result.ok) this.feed.phase(round.roundId, "started");
  }

  private async afterReveal(roundId: bigint, seed: Uint8Array, before: RoundAccount): Promise<void> {
    const expected = await expectedCrash(this.programIdBytes, roundId, before.rulesVersion, seed, before.vrfOutput);
    const revealed = await this.chain.round(roundId);
    const matches = revealed?.crashPoint === expected.crashPoint && revealed?.crashTick === expected.crashTick;
    log[matches ? "info" : "error"]("round-revealed", {
      roundId: String(roundId),
      crashPoint: String(revealed?.crashPoint),
      bets: revealed?.betCount,
      matchesOperator: matches,
    });
    this.endRound(roundId);
  }

  private endRound(roundId: bigint): void {
    // After reveal the seed is public; after void or forfeit it is useless.
    this.seeds.remove(roundId);
    this.failedOracles.delete(roundId);
    this.lastRoundEndedAt = Date.now();
  }

  /**
   * Settles bets of finished rounds until `stopAt` (ms); returns how many landed. Failures never
   * block a round: the next window retries, and players can also settle in their next bet (§4.2).
   */
  private async settlePending(stopAt: number): Promise<number> {
    const pending = await this.chain.pendingBets();
    if (pending.length === 0) return 0;
    const phases = new Map<bigint, boolean>();
    for (const roundId of new Set(pending.map((bet) => bet.roundId))) {
      const round = await this.chain.round(roundId);
      phases.set(roundId, round !== null && isTerminalPhase(round.phase));
    }
    const settleable = pending.filter((bet) => phases.get(bet.roundId));
    let settled = 0;
    for (let index = 0; index < settleable.length; index += SETTLEMENTS_PER_TRANSACTION) {
      if (Date.now() >= stopAt) {
        log.info("settle-deferred", { bets: settleable.length - index });
        break;
      }
      const batch = settleable.slice(index, index + SETTLEMENTS_PER_TRANSACTION);
      const result = await this.chain.send(batch.map((bet) => settleBetIx(CRASH_PROGRAM_ID, bet.owner, bet.roundId)));
      if (result.ok) settled += batch.length;
      log[result.ok ? "info" : "warn"]("settle", {
        bets: batch.map((bet) => `${bet.roundId}:${bet.owner.toBase58()}`),
        ...(result.ok ? { signature: result.signature } : { error: result.programError ?? result.error }),
      });
    }
    return settled;
  }

  private report(action: CrankAction, result: SendResult, extra: Record<string, unknown> = {}): void {
    const roundId = "roundId" in action ? String(action.roundId) : undefined;
    const reason = "reason" in action ? action.reason : undefined;
    if (result.ok) log.info(action.kind, { roundId, reason, signature: result.signature, ...extra });
    else log.warn(`${action.kind}-failed`, { roundId, reason, error: result.programError ?? result.error, ...extra });
  }
}

async function main(): Promise<void> {
  const config = parseOperatorConfig(process.env, process.cwd());
  const operator = loadKeypair(config.keypairPath);
  const connection = new Connection(config.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: false });

  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error("RPC is not Solana devnet");
  const chain = new OperatorChain(connection, operator, CRASH_PROGRAM_ID, config.priorityFeeMicroLamports);
  const { config: house } = await chain.snapshot();
  if (!house.operator.equals(operator.publicKey)) throw new Error("keypair is not the house operator");
  const balance = BigInt(await connection.getBalance(operator.publicKey, "confirmed"));
  if (balance < MIN_OPERATOR_LAMPORTS) log.warn("low-operator-balance", { lamports: String(balance) });

  log.info("started", {
    operator: operator.publicKey.toBase58(),
    program: CRASH_PROGRAM_ID.toBase58(),
    rpcHost: new URL(config.rpcUrl).host,
    lamports: String(balance),
  });
  let feed: LiveFeed = DISABLED_FEED;
  if (config.liveFeed) {
    const sse = new SseLiveFeed(config.liveFeed);
    try {
      const address = await sse.listen();
      feed = sse;
      log.info("live-feed", { url: `http://127.0.0.1:${address.port}${FEED_PATH}`, origin: config.liveFeed.allowedOrigin });
    } catch (error) {
      // The feed is presentation only: the crank runs without it.
      log.warn("live-feed-unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const crank = new Crank(
    chain,
    createFileSeedStore(join(config.stateDir, CRASH_PROGRAM_ID.toBase58())),
    feed,
    config.pauseBetweenRoundsMs,
    config.pollIntervalMs,
  );
  await crank.calibrate();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => crank.stop());
  // A stray rejection inside a library (e.g. a throttled RPC call) must not kill the crank: every
  // decision is re-derived from the chain on the next step, so continuing equals a restart.
  process.on("unhandledRejection", (reason) =>
    log.error("unhandled-rejection", { error: reason instanceof Error ? reason.message.split("\n")[0] : String(reason) }),
  );
  await crank.run();
  await feed.close();
}

main().catch((error) => {
  log.error("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
