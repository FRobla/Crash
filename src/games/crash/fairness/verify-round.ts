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

export interface DerivedOutcome {
  rules: CrashRules;
  /** What `seed` commits to; the caller compares it with the round's recorded commit. */
  commitment: Uint8Array;
  entropy: Uint8Array;
  crashPoint: Multiplier;
  crashTick: bigint;
}

/**
 * The outcome a seed and VRF output produce for a round, exactly as the program derives it.
 * `null` for unknown rules or inputs that are not 32 bytes. Shared by the verifier, the crank and
 * the web's provisional crash (spec crash-client-v1 §5.2).
 */
export async function deriveOutcome(
  programId: Uint8Array,
  roundId: bigint,
  rulesVersion: number,
  seed: Uint8Array,
  vrfOutput: Uint8Array,
  sha256: Sha256 = webCryptoSha256,
): Promise<DerivedOutcome | null> {
  const rules = rulesForVersion(rulesVersion);
  if (!rules || [programId, seed, vrfOutput].some((bytes) => bytes.length !== 32)) return null;
  const commitment = await computeCommitment(programId, roundId, seed, sha256);
  const entropy = await computeEntropy(programId, roundId, seed, vrfOutput, sha256);
  const crashPoint = crashPointFromEntropy(entropy, rules);
  return { rules, commitment, entropy, crashPoint, crashTick: BigInt(crashTick(curveFor(rules), crashPoint)) };
}

export async function verifyRound(evidence: RoundEvidence, sha256: Sha256 = webCryptoSha256): Promise<Verification> {
  if (evidence.outcome !== "revealed") return { status: "unverifiable", reason: evidence.outcome };
  if (!rulesForVersion(evidence.rulesVersion)) return { status: "unverifiable", reason: "unknown-rules" };
  if (evidence.commit.length !== 32) return { status: "unverifiable", reason: "malformed" };
  const derived = await deriveOutcome(
    evidence.programId,
    evidence.roundId,
    evidence.rulesVersion,
    evidence.seed,
    evidence.vrfOutput,
    sha256,
  );
  if (!derived) return { status: "unverifiable", reason: "malformed" };
  const { rules, commitment, entropy, crashPoint, crashTick: tick } = derived;

  const checks: VerificationCheck[] = [
    { name: "commitment", expected: toHex(evidence.commit), actual: toHex(commitment), ok: toHex(commitment) === toHex(evidence.commit) },
    { name: "crash-point", expected: evidence.crashPoint.toString(), actual: crashPoint.toString(), ok: crashPoint === evidence.crashPoint },
    { name: "crash-tick", expected: evidence.crashTick.toString(), actual: tick.toString(), ok: tick === evidence.crashTick },
  ];
  return { status: checks.every((check) => check.ok) ? "verified" : "mismatch", rules, entropy, checks };
}
