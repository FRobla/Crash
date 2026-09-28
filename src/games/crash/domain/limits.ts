import type { Bet } from "./bet";
import { err, ok, type Result } from "./result";
import {
  assertValidMaxMultiplier,
  isCentiPrecise,
  MIN_CASH_OUT_MULTIPLIER,
  payoutFor,
  type Amount,
  type Multiplier,
} from "./units";

/** Per-asset limits (spec §7). Concrete values belong to the house bank spec. */
export interface BetLimits {
  minStake: Amount;
  maxStake: Amount;
  maxPayout: Amount;
  maxRoundExposure: Amount;
}

export type BetRejection =
  | "stake-below-minimum"
  | "stake-above-maximum"
  | "auto-cash-out-not-centi-precise"
  | "auto-cash-out-below-minimum"
  | "auto-cash-out-above-maximum"
  | "payout-above-maximum";

export type RoundExposureRejection = "round-exposure-exceeded";

export function assertValidBetLimits(limits: BetLimits): void {
  if (limits.minStake < 1n || limits.maxStake < limits.minStake) {
    throw new RangeError("stake limits must satisfy 1 <= minStake <= maxStake");
  }
  if (limits.maxPayout < 0n || limits.maxRoundExposure < 0n) {
    throw new RangeError("payout and exposure limits must be non-negative");
  }
}

/** Largest payout a bet can receive under any settlement, including a forfeit. */
export function betExposure(bet: Pick<Bet, "stake" | "autoCashOut">, maxMultiplier: Multiplier): Amount {
  return payoutFor(bet.stake, bet.autoCashOut ?? maxMultiplier);
}

/** Checks a bet against the per-asset limits; on success returns its exposure. */
export function validateBet(
  bet: Pick<Bet, "stake" | "autoCashOut">,
  limits: BetLimits,
  maxMultiplier: Multiplier,
): Result<Amount, BetRejection> {
  assertValidBetLimits(limits);
  assertValidMaxMultiplier(maxMultiplier);

  if (bet.stake < limits.minStake) return err("stake-below-minimum");
  if (bet.stake > limits.maxStake) return err("stake-above-maximum");

  const target = bet.autoCashOut;
  if (target !== null) {
    if (!isCentiPrecise(target)) return err("auto-cash-out-not-centi-precise");
    if (target < MIN_CASH_OUT_MULTIPLIER) return err("auto-cash-out-below-minimum");
    if (target > maxMultiplier) return err("auto-cash-out-above-maximum");
  }

  const exposure = betExposure(bet, maxMultiplier);
  if (exposure > limits.maxPayout) return err("payout-above-maximum");
  return ok(exposure);
}

/** On success returns the round's new total exposure. */
export function validateRoundExposure(
  currentExposure: Amount,
  additionalExposure: Amount,
  limits: BetLimits,
): Result<Amount, RoundExposureRejection> {
  const total = currentExposure + additionalExposure;
  return total > limits.maxRoundExposure ? err("round-exposure-exceeded") : ok(total);
}
