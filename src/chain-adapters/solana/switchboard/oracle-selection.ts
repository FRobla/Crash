import type { PublicKey } from "@solana/web3.js";
import type { OracleData, QueueData } from "./accounts";
import { VERIFIED_STATUS } from "./accounts";

/**
 * Oracle eligibility for `close_betting` (spec crash-client-v1 §4.5), mirroring the on-chain checks
 * the Switchboard SDK applies: on the queue, enclave verified, fresh heartbeat and a quote that has
 * not expired. Switchboard itself validates the oracle during the commit; this only avoids picking
 * one that is likely dead, which would void the round.
 */

export interface OracleCandidate {
  key: PublicKey;
  data: OracleData;
}

export type IneligibleReason = "other-queue" | "off-queue" | "unverified" | "stale-heartbeat" | "expired-quote" | "no-gateway";

export function oracleIneligibility(
  candidate: OracleCandidate,
  queueKey: PublicKey,
  queue: QueueData,
  nowUnix: bigint,
): IneligibleReason | null {
  const { data } = candidate;
  if (!data.queue.equals(queueKey)) return "other-queue";
  if (!data.isOnQueue) return "off-queue";
  if (data.verificationStatus !== VERIFIED_STATUS) return "unverified";
  if (nowUnix - data.lastHeartbeat > queue.nodeTimeout) return "stale-heartbeat";
  if (data.validUntil <= nowUnix) return "expired-quote";
  if (!data.gatewayUri.startsWith("https://")) return "no-gateway";
  return null;
}

/** Eligible oracles in random order (`random` in `[0, 1)`), skipping any in `exclude`. */
export function rankOracles(
  candidates: readonly OracleCandidate[],
  queueKey: PublicKey,
  queue: QueueData,
  nowUnix: bigint,
  exclude: ReadonlySet<string> = new Set(),
  random: () => number = Math.random,
): OracleCandidate[] {
  const eligible = candidates.filter(
    (candidate) =>
      !exclude.has(candidate.key.toBase58()) && oracleIneligibility(candidate, queueKey, queue, nowUnix) === null,
  );
  // Fisher–Yates: spreading load across oracles is enough; this choice is not security relevant.
  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [eligible[index], eligible[swap]] = [eligible[swap], eligible[index]];
  }
  return eligible;
}
