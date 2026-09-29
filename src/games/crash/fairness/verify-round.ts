import { crashPointFromEntropy } from "../domain/crash-point";
import { createMultiplierCurve, crashTick, type MultiplierCurve } from "../domain/multiplier-curve";
import { rulesForVersion, type CrashRules } from "../domain/rules";
import type { Multiplier } from "../domain/units";

/**
 * Independent verification of a round (ADR 0002 scheme C; docs/specs/crash-client-v1.md §8):
 *   commit  = SHA256("crash/v1/commit"  ‖ program_id ‖ round_id_le ‖ seed)
 *   entropy = SHA256("crash/v1/entropy" ‖ program_id ‖ round_id_le ‖ seed ‖ vrf_output)
 * It works on bytes only, so it knows nothing about a specific chain or wallet.
 */

export const COMMIT_TAG = "crash/v1/commit";
export const ENTROPY_TAG = "crash/v1/entropy";

export type Sha256 = (data: Uint8Array) => Promise<Uint8Array>;

export const webCryptoSha256: Sha256 = async (data) =>
  new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));

/** How the round ended, as far as verification is concerned. */
export type RoundOutcomeKind = "revealed" | "pending" | "voided" | "forfeited";

export interface RoundEvidence {
  /** 32-byte id of the settlement program (domain separation). */
  programId: Uint8Array;
  roundId: bigint;
  rulesVersion: number;
  outcome: RoundOutcomeKind;
  commit: Uint8Array;
  seed: Uint8Array;
  vrfOutput: Uint8Array;
  /** As recorded by the settlement authority. */
  crashPoint: Multiplier;
  crashTick: bigint;
}

export interface VerificationCheck {
  name: "commitment" | "crash-point" | "crash-tick";
  expected: string;
  actual: string;
  ok: boolean;
}

export type Verification =
  | { status: "verified" | "mismatch"; rules: CrashRules; entropy: Uint8Array; checks: VerificationCheck[] }
  | { status: "unverifiable"; reason: "pending" | "voided" | "forfeited" | "unknown-rules" | "malformed" };

const encoder = new TextEncoder();

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function computeCommitment(
  programId: Uint8Array,
  roundId: bigint,
  seed: Uint8Array,
  sha256: Sha256 = webCryptoSha256,
): Promise<Uint8Array> {
  return sha256(concat([encoder.encode(COMMIT_TAG), programId, u64Le(roundId), seed]));
}

export function computeEntropy(
  programId: Uint8Array,
  roundId: bigint,
  seed: Uint8Array,
  vrfOutput: Uint8Array,
  sha256: Sha256 = webCryptoSha256,
): Promise<Uint8Array> {
  return sha256(concat([encoder.encode(ENTROPY_TAG), programId, u64Le(roundId), seed, vrfOutput]));
}

const curves = new Map<number, MultiplierCurve>();

function curveFor(rules: CrashRules): MultiplierCurve {
  let curve = curves.get(rules.version);
  if (!curve) {
    curve = createMultiplierCurve(rules.growthPpm, rules.maxMultiplier);
    curves.set(rules.version, curve);
  }
  return curve;
}

export async function verifyRound(evidence: RoundEvidence, sha256: Sha256 = webCryptoSha256): Promise<Verification> {
  if (evidence.outcome !== "revealed") return { status: "unverifiable", reason: evidence.outcome };
  const rules = rulesForVersion(evidence.rulesVersion);
  if (!rules) return { status: "unverifiable", reason: "unknown-rules" };
  const sizes = [evidence.programId, evidence.commit, evidence.seed, evidence.vrfOutput].map((b) => b.length);
  if (sizes.some((size) => size !== 32)) return { status: "unverifiable", reason: "malformed" };

  const commitment = await computeCommitment(evidence.programId, evidence.roundId, evidence.seed, sha256);
  const entropy = await computeEntropy(evidence.programId, evidence.roundId, evidence.seed, evidence.vrfOutput, sha256);
  const crashPoint = crashPointFromEntropy(entropy, rules);
  const tick = BigInt(crashTick(curveFor(rules), crashPoint));

  const checks: VerificationCheck[] = [
    { name: "commitment", expected: toHex(evidence.commit), actual: toHex(commitment), ok: toHex(commitment) === toHex(evidence.commit) },
    { name: "crash-point", expected: evidence.crashPoint.toString(), actual: crashPoint.toString(), ok: crashPoint === evidence.crashPoint },
    { name: "crash-tick", expected: evidence.crashTick.toString(), actual: tick.toString(), ok: tick === evidence.crashTick },
  ];
  return { status: checks.every((check) => check.ok) ? "verified" : "mismatch", rules, entropy, checks };
}
