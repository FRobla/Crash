import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  type SendOptions as SendOptionsWeb3,
  type TransactionInstruction,
} from "@solana/web3.js";
import { msPerSlotFromSamples } from "@/chain-adapters/solana/network/slot-clock";
import {
  PLAYER_ACTIVE_BET_TAG_OFFSET,
  decodeHouseConfig,
  decodePlayer,
  decodeRound,
  type HouseConfigAccount,
  type RoundAccount,
} from "@/chain-adapters/solana/crash-program/accounts";
import { describeProgramError } from "@/chain-adapters/solana/crash-program/errors";
import { confirmSignature, failureReason } from "@/chain-adapters/solana/crash-program/send";
import { idlAccountDiscriminator } from "@/chain-adapters/solana/crash-program/idl";
import { houseConfigAddress, roundAddress } from "@/chain-adapters/solana/crash-program/pdas";
import {
  parseOracle,
  parseQueue,
  parseRandomness,
  type OracleData,
  type QueueData,
  type RandomnessData,
} from "@/chain-adapters/solana/switchboard/accounts";
import type { OracleCandidate } from "@/chain-adapters/solana/switchboard/oracle-selection";

/** RPC access for the crank: snapshots, pending bets and signed sends with a priority fee. */

export interface Snapshot {
  config: HouseConfigAccount;
  round: RoundAccount | null;
  slot: bigint;
}

export interface PendingBet {
  owner: PublicKey;
  roundId: bigint;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export type SendResult = { ok: true; signature: string } | { ok: false; error: string; programError: string | null };

export class OperatorChain {
  constructor(
    readonly connection: Connection,
    readonly operator: Keypair,
    readonly programId: PublicKey,
    private readonly priorityFeeMicroLamports: number,
  ) {}

  async snapshot(): Promise<Snapshot> {
    const configInfo = await this.connection.getAccountInfoAndContext(houseConfigAddress(this.programId), "confirmed");
    if (!configInfo.value) throw new Error("house config not found");
    const config = decodeHouseConfig(configInfo.value, this.programId);
    let round: RoundAccount | null = null;
    let slot = BigInt(configInfo.context.slot);
    if (config.currentRound !== null) {
      const roundInfo = await this.connection.getAccountInfoAndContext(
        roundAddress(this.programId, config.currentRound),
        "confirmed",
      );
      if (roundInfo.value) round = decodeRound(roundInfo.value, this.programId);
      slot = BigInt(roundInfo.context.slot);
    }
    return { config, round, slot };
  }

  async round(roundId: bigint): Promise<RoundAccount | null> {
    const info = await this.connection.getAccountInfo(roundAddress(this.programId, roundId), "confirmed");
    return info ? decodeRound(info, this.programId) : null;
  }

  /** Every `Player` holding an active bet, found by account filters rather than events (spec §4.2). */
  async pendingBets(): Promise<PendingBet[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, encoding: "base64", bytes: base64(idlAccountDiscriminator("Player")) } },
        { memcmp: { offset: PLAYER_ACTIVE_BET_TAG_OFFSET, encoding: "base64", bytes: base64(Uint8Array.of(1)) } },
      ],
    });
    return accounts.flatMap(({ account }) => {
      const player = decodePlayer(account, this.programId);
      return player.activeBet ? [{ owner: player.owner, roundId: player.activeBet.roundId }] : [];
    });
  }

  async switchboard(randomnessKey: PublicKey): Promise<{
    randomness: RandomnessData;
    queue: QueueData;
    oracles: OracleCandidate[];
    nowUnix: bigint;
  }> {
    const randomnessInfo = await this.connection.getAccountInfo(randomnessKey, "confirmed");
    if (!randomnessInfo) throw new Error("randomness account not found");
    const randomness = parseRandomness(randomnessInfo);
    const queueInfo = await this.connection.getAccountInfo(randomness.queue, "confirmed");
    if (!queueInfo) throw new Error("Switchboard queue not found");
    const queue = parseQueue(queueInfo);
    const infos = await this.connection.getMultipleAccountsInfo(queue.oracleKeys, "confirmed");
    const oracles = queue.oracleKeys.flatMap((key, index) => {
      const info = infos[index];
      if (!info) return [];
      try {
        return [{ key, data: parseOracle(info) }];
      } catch {
        return [];
      }
    });
    const slot = await this.connection.getSlot("confirmed");
    const time = await this.connection.getBlockTime(slot);
    return { randomness, queue, oracles, nowUnix: BigInt(time ?? Math.floor(Date.now() / 1000)) };
  }

  async randomness(key: PublicKey): Promise<RandomnessData> {
    const info = await this.connection.getAccountInfo(key, "confirmed");
    if (!info) throw new Error("randomness account not found");
    return parseRandomness(info);
  }

  async oracle(key: PublicKey): Promise<OracleData> {
    const info = await this.connection.getAccountInfo(key, "confirmed");
    if (!info) throw new Error("oracle account not found");
    return parseOracle(info);
  }

  async slot(): Promise<bigint> {
    return BigInt(await this.connection.getSlot("confirmed"));
  }

  /** Average slot duration reported by the cluster, or null if unavailable. */
  async measuredMsPerSlot(): Promise<number | null> {
    try {
      return msPerSlotFromSamples(await this.connection.getRecentPerformanceSamples(10));
    } catch {
      return null;
    }
  }

  /**
   * Signs, submits and confirms. Submission always runs the RPC's preflight simulation against the
   * `confirmed` bank (never `skipPreflight`); `onSubmitted` runs only once the transaction passed
   * it, before confirmation. The crank publishes a round's seed from there (ADR 0004), so a reveal
   * that would fail (e.g. sent before the crash tick) never leaks it.
   */
  async send(instructions: TransactionInstruction[], options: SendOptions = {}): Promise<SendResult> {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({ feePayer: this.operator.publicKey, blockhash, lastValidBlockHeight });
      if (this.priorityFeeMicroLamports > 0) {
        transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeMicroLamports }));
      }
      transaction.add(...instructions);
      transaction.sign(this.operator);
      assertPreflight(SUBMIT_OPTIONS);
      const signature = await this.connection.sendRawTransaction(transaction.serialize(), SUBMIT_OPTIONS);
      try {
        options.onSubmitted?.(signature);
      } catch {
        // Presentation hooks never affect the transaction.
      }
      // Polling confirmation (no WebSocket): public RPCs rate-limit subscriptions, and web3.js
      // `confirmTransaction` can leak rejections from its background requests.
      await confirmSignature(this.connection, signature, lastValidBlockHeight, CONFIRM_POLL_MS);
      return { ok: true, signature };
    } catch (error) {
      const logs = error instanceof SendTransactionError ? error.logs : undefined;
      return { ok: false, error: failureReason(error), programError: describeProgramError(error, logs) };
    }
  }
}

export interface SendOptions {
  /** Runs after the transaction passed preflight and the RPC accepted it, before confirmation. */
  onSubmitted?: (signature: string) => void;
}

/** Every crank transaction is simulated before it is sent; nothing may override this. */
export const SUBMIT_OPTIONS: Readonly<SendOptionsWeb3> = Object.freeze({
  skipPreflight: false,
  preflightCommitment: "confirmed",
  maxRetries: 5,
});

const CONFIRM_POLL_MS = 500;

export function assertPreflight(options: Readonly<SendOptionsWeb3>): void {
  if (options.skipPreflight !== false || options.preflightCommitment !== "confirmed") {
    throw new Error("crank transactions must run preflight against the confirmed bank");
  }
}
