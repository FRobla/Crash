/**
 * Units of the Crash domain (spec §2). Money never uses `number`.
 */

/** Non-negative amount in the asset's base units (e.g. lamports, 10⁻⁶ USDC). */
export type Amount = bigint;

/** Multiplier in ten-thousandths: `1.0000x = 10_000n`. */
export type Multiplier = bigint;

export const MULTIPLIER_SCALE = 10_000n;
export const ONE_X: Multiplier = MULTIPLIER_SCALE;

/** One hundredth of a multiplier (0.01x), the recognized precision. */
export const CENTI_STEP = 100n;

/** Lowest multiplier at which any cash-out can be recognized. */
export const MIN_CASH_OUT_MULTIPLIER: Multiplier = 10_100n;

/** Upper bound for a configurable `maxMultiplier` (1,000,000x). */
export const MAX_SUPPORTED_MULTIPLIER: Multiplier = 1_000_000n * MULTIPLIER_SCALE;

export function truncateToCenti(multiplier: Multiplier): Multiplier {
  return (multiplier / CENTI_STEP) * CENTI_STEP;
}

export function isCentiPrecise(multiplier: Multiplier): boolean {
  return multiplier % CENTI_STEP === 0n;
}

/** `⌊stake · multiplier / 10_000⌋`; the truncation favors the house by at most one base unit. */
export function payoutFor(stake: Amount, multiplier: Multiplier): Amount {
  if (stake < 0n || multiplier < 0n) {
    throw new RangeError("stake and multiplier must be non-negative");
  }
  return (stake * multiplier) / MULTIPLIER_SCALE;
}

export function assertValidMaxMultiplier(maxMultiplier: Multiplier): void {
  if (
    !isCentiPrecise(maxMultiplier) ||
    maxMultiplier < MIN_CASH_OUT_MULTIPLIER ||
    maxMultiplier > MAX_SUPPORTED_MULTIPLIER
  ) {
    throw new RangeError("maxMultiplier must be centi-precise and within [1.01x, 1000000x]");
  }
}
