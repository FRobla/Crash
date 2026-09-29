import { computeCommitment, computeEntropy, toHex, type Sha256 } from "@/games/crash/fairness/verify-round";
import { crashPointFromEntropy } from "@/games/crash/domain/crash-point";
import { createMultiplierCurve, crashTick } from "@/games/crash/domain/multiplier-curve";
import { rulesForVersion } from "@/games/crash/domain/rules";

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
  const rules = rulesForVersion(rulesVersion);
  if (!rules) throw new Error(`unknown rules version ${rulesVersion}`);
  const entropy = await computeEntropy(programId, roundId, seed, vrfOutput, sha256);
  const crashPoint = crashPointFromEntropy(entropy, rules);
  const curve = createMultiplierCurve(rules.growthPpm, rules.maxMultiplier);
  return { crashPoint, crashTick: BigInt(crashTick(curve, crashPoint)) };
}
