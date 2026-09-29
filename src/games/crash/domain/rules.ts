import type { CrashPointParams } from "./crash-point";
import type { Multiplier } from "./units";

/**
 * Immutable, versioned rule sets (spec §5.1). Any change to the algorithm or its parameters
 * requires a new version; historical versions must stay available to verifiers.
 */
export interface CrashRules extends CrashPointParams {
  readonly version: number;
  readonly houseEdgeBps: bigint;
  readonly growthPpm: bigint;
  readonly maxMultiplier: Multiplier;
}

/** Approved for devnet only; requires a risk review before real funds. */
export const CRASH_RULES_V1: CrashRules = Object.freeze({
  version: 1,
  houseEdgeBps: 300n,
  growthPpm: 24_000n,
  maxMultiplier: 1_000_000n,
});

const RULES_BY_VERSION: ReadonlyMap<number, CrashRules> = new Map([[CRASH_RULES_V1.version, CRASH_RULES_V1]]);

/** Published rule set for a round's `rulesVersion`; `null` if this build does not know it. */
export function rulesForVersion(version: number): CrashRules | null {
  return RULES_BY_VERSION.get(version) ?? null;
}
