import type { Bet, CashOutRequest } from "./bet";
import {
  crashTick,
  firstTickAtLeast,
  recognizedMultiplierAtTick,
  type MultiplierCurve,
} from "./multiplier-curve";
import { isCentiPrecise, MIN_CASH_OUT_MULTIPLIER, ONE_X, payoutFor, type Amount, type Multiplier } from "./units";

/**
 * Round settlement (spec §6). Single winning rule: a cash-out recognized at multiplier `m` wins iff
 * `1.01x <= m <= crashPoint`. The result depends only on the recognized ticks, never on input order.
 */

export type Settlement =
  | { betId: string; stake: Amount; outcome: "cashed-out"; multiplier: Multiplier; payout: Amount }
  | { betId: string; stake: Amount; outcome: "lost"; payout: Amount }
  | { betId: string; stake: Amount; outcome: "refunded"; payout: Amount };

export type IgnoredCashOutReason = "unknown-bet" | "invalid-tick" | "below-minimum-multiplier";

export interface IgnoredCashOut {
  request: CashOutRequest;
  reason: IgnoredCashOutReason;
}

export interface RoundSettlement {
  /** One entry per bet, in the order the bets were given. */
  settlements: Settlement[];
  totalStake: Amount;
  totalPayout: Amount;
  /** Canonically ordered by `(betId, tick, reason)`. */
  ignored: IgnoredCashOut[];
}

interface CashOutCandidate {
  tick: number;
  multiplier: Multiplier;
}

export function settleRound(
  bets: readonly Bet[],
  cashOuts: readonly CashOutRequest[],
  crashPoint: Multiplier,
  curve: MultiplierCurve,
): RoundSettlement {
  assertValidBets(bets);
  for (const bet of bets) {
    const target = bet.autoCashOut;
    if (
      target !== null &&
      (!isCentiPrecise(target) || target < MIN_CASH_OUT_MULTIPLIER || target > curve.maxMultiplier)
    ) {
      throw new RangeError("auto cash-out targets must be centi-precise and within [1.01x, maxMultiplier]");
    }
  }
  if (crashPoint < ONE_X || crashPoint > curve.maxMultiplier) {
    throw new RangeError("crashPoint must be within [1.00x, maxMultiplier]");
  }

  const endTick = crashTick(curve, crashPoint);
  const betIds = new Set(bets.map((bet) => bet.id));
  const ignored: IgnoredCashOut[] = [];
  const earliestManual = new Map<string, CashOutCandidate>();

  for (const request of cashOuts) {
    if (!betIds.has(request.betId)) {
      ignored.push({ request, reason: "unknown-bet" });
    } else if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
      ignored.push({ request, reason: "invalid-tick" });
    } else if (request.tick < endTick) {
      const multiplier = recognizedMultiplierAtTick(curve, request.tick);
      if (multiplier < MIN_CASH_OUT_MULTIPLIER) {
        ignored.push({ request, reason: "below-minimum-multiplier" });
        continue;
      }
      const current = earliestManual.get(request.betId);
      if (current === undefined || request.tick < current.tick) {
        earliestManual.set(request.betId, { tick: request.tick, multiplier });
      }
    }
    // Requests at or after the crash tick arrived too late: they leave the bet as it is.
  }

  const settlements = bets.map((bet): Settlement => {
    const auto =
      bet.autoCashOut !== null && bet.autoCashOut <= crashPoint
        ? { tick: firstTickAtLeast(curve, bet.autoCashOut), multiplier: bet.autoCashOut }
        : undefined;
    const manual = earliestManual.get(bet.id);
    // On a tick tie the auto cash-out precedes the manual one.
    const winner = manual !== undefined && (auto === undefined || manual.tick < auto.tick) ? manual : auto;

    if (winner === undefined) {
      return { betId: bet.id, stake: bet.stake, outcome: "lost", payout: 0n };
    }
    return {
      betId: bet.id,
      stake: bet.stake,
      outcome: "cashed-out",
      multiplier: winner.multiplier,
      payout: payoutFor(bet.stake, winner.multiplier),
    };
  });

  return summarize(settlements, sortIgnored(ignored));
}

/** A `voided` round (cancelled before running): every stake is refunded exactly. */
export function refundRound(bets: readonly Bet[]): RoundSettlement {
  assertValidBets(bets);
  return summarize(
    bets.map((bet): Settlement => ({ betId: bet.id, stake: bet.stake, outcome: "refunded", payout: bet.stake })),
    [],
  );
}

/**
 * A `forfeited` round (not revealed after it started): settled as if it reached `maxMultiplier`,
 * and bets without a winning cash-out are refunded. Never cheaper for the house than revealing.
 */
export function settleForfeitedRound(
  bets: readonly Bet[],
  cashOuts: readonly CashOutRequest[],
  curve: MultiplierCurve,
): RoundSettlement {
  const atMaximum = settleRound(bets, cashOuts, curve.maxMultiplier, curve);
  return summarize(
    atMaximum.settlements.map((settlement): Settlement =>
      settlement.outcome === "lost"
        ? { betId: settlement.betId, stake: settlement.stake, outcome: "refunded", payout: settlement.stake }
        : settlement,
    ),
    atMaximum.ignored,
  );
}

function assertValidBets(bets: readonly Bet[]): void {
  if (new Set(bets.map((bet) => bet.id)).size !== bets.length) {
    throw new RangeError("bet ids must be unique");
  }
  if (bets.some((bet) => bet.stake < 0n)) {
    throw new RangeError("stakes must be non-negative");
  }
}

function summarize(settlements: Settlement[], ignored: IgnoredCashOut[]): RoundSettlement {
  let totalStake = 0n;
  let totalPayout = 0n;
  for (const settlement of settlements) {
    totalStake += settlement.stake;
    totalPayout += settlement.payout;
  }
  return { settlements, totalStake, totalPayout, ignored };
}

function sortIgnored(ignored: IgnoredCashOut[]): IgnoredCashOut[] {
  return ignored.sort(
    (a, b) =>
      compareStrings(a.request.betId, b.request.betId) ||
      compareTicks(a.request.tick, b.request.tick) ||
      compareStrings(a.reason, b.reason),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order over any `number`, including NaN, so invalid ticks sort deterministically. */
function compareTicks(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number(Number.isNaN(a)) - Number(Number.isNaN(b));
  return a < b ? -1 : a > b ? 1 : 0;
}
