import { computeCommitment, deriveOutcome, toHex, type Sha256 } from "@/games/crash/fairness/verify-round";

/** The operator's own view of a round's outcome, derived exactly like the program and verifiers. */

export async function seedMatchesCommit(
  programId: Uint8Array,
  roundId: bigint,
  seed: Uint8Array,
  commit: Uint8Array,
  sha256?: Sha256,
): Promise<boolean> {
  return toHex(await computeCommitment(programId, roundId, seed, sha256)) === toHex(commit);
}

export async function expectedCrash(
  programId: Uint8Array,
  roundId: bigint,
  rulesVersion: number,
  seed: Uint8Array,
  vrfOutput: Uint8Array,
  sha256?: Sha256,
): Promise<{ crashPoint: bigint; crashTick: bigint }> {
  const outcome = await deriveOutcome(programId, roundId, rulesVersion, seed, vrfOutput, sha256);
  if (!outcome) throw new Error(`cannot derive round ${roundId} (rules version ${rulesVersion})`);
  return { crashPoint: outcome.crashPoint, crashTick: outcome.crashTick };
}
