import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { decodeHouseConfig, decodePlayer, decodeRound, type RoundAccount } from "@/chain-adapters/solana/crash-program/accounts";
import { CRASH_PROGRAM_ID } from "@/chain-adapters/solana/crash-program/deployment";
import { fetchSettledBets } from "@/chain-adapters/solana/crash-program/bet-history";
import {
  buyCoinsIx,
  cashOutIx,
  createSessionIx,
  placeBetIx,
  registerPlayerIx,
  revokeSessionIx,
  sellCoinsIx,
  settleBetIx,
} from "@/chain-adapters/solana/crash-program/instructions";
import { houseConfigAddress, playerAddress, roundAddress } from "@/chain-adapters/solana/crash-program/pdas";
import { roundEvidence } from "@/chain-adapters/solana/crash-program/round-evidence";
import { failureReason, sendSigned } from "@/chain-adapters/solana/crash-program/send";
import { toLiveRound } from "@/chain-adapters/solana/crash-program/view-mapping";
import { verifyRound } from "@/games/crash/fairness/verify-round";
import { myBetOutcome } from "@/games/crash/ui/round-view";
import { parseOperatorConfig } from "./config";

/**
 * Devnet end-to-end player (docs/specs/crash-client-v1.md §12). It plays against the running crank
 * with the same instruction builders, session flow and rules the web app uses: one wallet
 * signature to register, bets and cash-outs signed by the session key, then a full exit. Every
 * settlement is checked against the domain engine and every revealed round against the verifier.
 * Funds come from the operator keypair and go back to it; devnet only.
 */

const PID = CRASH_PROGRAM_ID;
const ROUNDS = Number(process.env.E2E_ROUNDS ?? 6);
const FUNDING = 60_000_000n;
const COINS = 10_000_000n;
const STAKE = 1_000_000n;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const config = parseOperatorConfig(process.env, process.cwd());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(config.keypairPath, "utf8")) as number[]));
const connection = new Connection(config.rpcUrl, "confirmed");
// Throwaway devnet keys, kept outside the repo until the run finishes so a failed run can resume
// and return its funds instead of stranding them.
const keyFile = join(config.stateDir, "e2e-player.json");
const saved = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as { owner: number[]; session: number[] }) : null;
const owner = saved ? Keypair.fromSecretKey(Uint8Array.from(saved.owner)) : Keypair.generate();
const session = saved ? Keypair.fromSecretKey(Uint8Array.from(saved.session)) : Keypair.generate();
if (!saved) {
  writeFileSync(keyFile, JSON.stringify({ owner: [...owner.secretKey], session: [...session.secretKey] }), { mode: 0o600 });
}
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }, (_, value) => (typeof value === "bigint" ? value.toString() : value)));

async function send(label: string, instructions: TransactionInstruction[], signers: Keypair[], attempts = 1): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      transaction.sign(...signers);
      const signature = await sendSigned(connection, transaction, lastValidBlockHeight);
      log(label, { signature });
      return signature;
    } catch (error) {
      log(`${label}-failed`, { reason: failureReason(error), attempt });
      if (attempt >= attempts) return null;
      await sleep(3_000 * attempt);
    }
  }
}

async function snapshot() {
  const keys = [houseConfigAddress(PID), playerAddress(PID, owner.publicKey)];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const house = decodeHouseConfig(value[0]!, PID);
  const player = value[1] ? decodePlayer(value[1], PID) : null;
  const roundInfo = await connection.getAccountInfo(roundAddress(PID, house.nextRoundId - 1n), "confirmed");
  return { house, player, round: roundInfo ? decodeRound(roundInfo, PID) : null, slot: BigInt(context.slot) };
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const failures: string[] = [];
  log("start", { owner: owner.publicKey.toBase58(), session: session.publicKey.toBase58(), rounds: ROUNDS, resumed: Boolean(saved) });
  const existing = (await snapshot()).player;
  if (!existing) {
    await send("fund", [SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner.publicKey, lamports: FUNDING })], [funder]);

    // Registration: one owner signature, exactly like the web's "Create account".
    const slot = BigInt(await connection.getSlot("confirmed"));
    const username = `e2e_${owner.publicKey.toBase58().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const registered = await send(
      "register",
      [
        registerPlayerIx(PID, owner.publicKey, username),
        buyCoinsIx(PID, owner.publicKey, COINS),
        createSessionIx(PID, owner.publicKey, session.publicKey, {
          expiresSlot: slot + 216_000n,
          spendCap: COINS,
          feeBudget: 10_000_000n,
        }),
      ],
      [owner],
    );
    if (!registered) throw new Error("registration failed");
  }

  const played: bigint[] = [];
  // A resumed run whose session was already revoked only finishes the exit and the refund.
  const rounds = existing && !existing.session ? 0 : ROUNDS;
  for (let index = 0; index < rounds; index += 1) {
    const mode = (["manual", "auto", "hold"] as const)[index % 3];
    const betting = await waitFor("a betting round", async () => {
      const s = await snapshot();
      return s.round && s.round.phase === "Betting" && !played.includes(s.round.roundId) && s.slot + 8n < s.round.bettingEndSlot ? s : null;
    });
    const round = betting.round!;
    const previous = betting.player?.activeBet;
    const auto = mode === "auto" ? 15_000n : 0n;
    const bet = placeBetIx(PID, owner.publicKey, session.publicKey, { roundId: round.roundId, stake: STAKE, autoCashOut: auto });
    let placed = await send("bet", previous ? [settleBetIx(PID, owner.publicKey, previous.roundId), bet] : [bet], [session]);
    // Like the web (spec §6.2): the crank settles during betting too, so a bundled settlement may
    // lose the race with NoActiveBet; retry once without it.
    if (!placed && previous) placed = await send("bet-retry", [bet], [session]);
    if (!placed) {
      failures.push(`bet in round ${round.roundId}`);
      continue;
    }
    played.push(round.roundId);
    log("round", { roundId: round.roundId, mode });

    if (mode === "manual") {
      // Cash out a few ticks in, like a player pressing the button.
      const running = await waitFor("running", async () => {
        const s = await snapshot();
        return s.round?.roundId === round.roundId && s.round.phase !== "Betting" && s.round.phase !== "AwaitingEntropy" ? s : null;
      });
      if (running.round!.phase === "Running") {
        await waitFor("tick 8", async () => {
          const s = await snapshot();
          return s.slot >= running.round!.startSlot + 8n || s.round?.phase !== "Running" ? s : null;
        });
        await send("cash-out", [cashOutIx(PID, owner.publicKey, session.publicKey, round.roundId)], [session]);
      }
    }

    const finished: RoundAccount = await waitFor("round end", async () => {
      const info = await connection.getAccountInfo(roundAddress(PID, round.roundId), "confirmed");
      const r = info ? decodeRound(info, PID) : null;
      return r && ["Crashed", "Settled", "Voided", "Forfeited"].includes(r.phase) ? r : null;
    });
    // The crank settles every bet; wait for it rather than settling ourselves.
    const settled = await waitFor("settlement", async () => {
      const s = await snapshot();
      return s.player && !s.player.activeBet ? s.player : null;
    }, 90_000).catch(() => null);

    const betBefore = { roundId: round.roundId, stake: STAKE, autoCashOut: auto, exposure: 0n, cashOutTick: null as bigint | null };
    const event = (await fetchSettledBets(connection, owner.publicKey, 4)).find(
      (candidate) => candidate.roundId === round.roundId,
    );
    if (!event || !settled) {
      failures.push(`no settlement for round ${round.roundId}`);
      continue;
    }
    betBefore.cashOutTick = event.cashOutTick;
    const expected = myBetOutcome(toLiveRound(finished), betBefore);
    const expectedPayout = expected.kind === "lost" || expected.kind === "open" ? 0n : expected.payout;
    const verification = await verifyRound(roundEvidence(finished));
    const ok = expectedPayout === event.payout && (verification.status === "verified" || finished.phase === "Voided");
    if (!ok) failures.push(`round ${round.roundId}: payout ${event.payout} vs ${expectedPayout}, ${verification.status}`);
    log("settled", {
      roundId: round.roundId,
      phase: finished.phase,
      crashPoint: finished.crashPoint,
      cashOutTick: event.cashOutTick,
      outcome: event.outcome,
      payout: event.payout,
      expectedPayout,
      fairness: verification.status,
      balance: settled.balance,
      ok,
    });
  }

  // Exit: revoke, sell everything and sweep the session key, as the web's "Sell all & exit".
  const final = await snapshot();
  const sessionLamports = BigInt(await connection.getBalance(session.publicKey, "confirmed"));
  const exitIxs: TransactionInstruction[] = [];
  if (final.player?.activeBet) exitIxs.push(settleBetIx(PID, owner.publicKey, final.player.activeBet.roundId));
  if (final.player?.session) exitIxs.push(revokeSessionIx(PID, owner.publicKey, owner.publicKey));
  if (final.player && final.player.balance > 0n && !final.player.activeBet) {
    exitIxs.push(sellCoinsIx(PID, owner.publicKey, final.player.balance));
  }
  if (sessionLamports > 0n) {
    exitIxs.push(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: owner.publicKey, lamports: sessionLamports }));
  }
  if (exitIxs.length > 0) await send("exit", exitIxs, [owner, ...(sessionLamports > 0n ? [session] : [])]);
  const after = await snapshot();
  const ownerLamports = BigInt(await connection.getBalance(owner.publicKey, "confirmed"));
  const refunded = await send(
    "refund-funder",
    [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: funder.publicKey, lamports: ownerLamports - 5_000n })],
    [owner],
    5,
  );
  // Keep the throwaway keys until their funds are back: a rerun resumes and retries the refund.
  if (refunded) rmSync(keyFile, { force: true });
  else failures.push("refund to the funder failed; rerun to retry");
  log("done", {
    rounds: played.length,
    finalCoins: after.player?.balance,
    totalWagered: after.player?.totalWagered,
    returnedLamports: ownerLamports - 5_000n,
    failures,
  });
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  log("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
