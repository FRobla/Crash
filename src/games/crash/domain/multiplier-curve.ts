import { assertValidMaxMultiplier, ONE_X, truncateToCenti, type Multiplier } from "./units";

/**
 * Deterministic integer multiplier curve (spec §4):
 * `m₀ = 1.0000x`, `mₙ₊₁ = mₙ + ⌊mₙ · growthPpm / 1_000_000⌋`.
 * Ticks are abstract; the settlement authority maps them to real time.
 */
export interface MultiplierCurve {
  readonly growthPpm: bigint;
  readonly maxMultiplier: Multiplier;
  /** Raw multipliers from tick 0 up to the first tick whose recognized value exceeds `maxMultiplier`. */
  readonly points: readonly Multiplier[];
}

export const MIN_GROWTH_PPM = 1_000n;
export const MAX_GROWTH_PPM = 1_000_000n;
const PPM = 1_000_000n;

export function createMultiplierCurve(growthPpm: bigint, maxMultiplier: Multiplier): MultiplierCurve {
  if (growthPpm < MIN_GROWTH_PPM || growthPpm > MAX_GROWTH_PPM) {
    throw new RangeError("growthPpm must be within [1000, 1000000]");
  }
  assertValidMaxMultiplier(maxMultiplier);

  const points: Multiplier[] = [ONE_X];
  let current = ONE_X;
  while (truncateToCenti(current) <= maxMultiplier) {
    current += (current * growthPpm) / PPM;
    points.push(current);
  }
  return Object.freeze({ growthPpm, maxMultiplier, points: Object.freeze(points) });
}

function assertTickInHorizon(curve: MultiplierCurve, tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0 || tick >= curve.points.length) {
    throw new RangeError("tick is outside the curve horizon");
  }
}

export function multiplierAtTick(curve: MultiplierCurve, tick: number): Multiplier {
  assertTickInHorizon(curve, tick);
  return curve.points[tick];
}

/** The multiplier shown, compared and paid at a tick: truncated to hundredths. */
export function recognizedMultiplierAtTick(curve: MultiplierCurve, tick: number): Multiplier {
  return truncateToCenti(multiplierAtTick(curve, tick));
}

/** First tick whose recognized multiplier is `>= target`; `target` must not exceed `maxMultiplier`. */
export function firstTickAtLeast(curve: MultiplierCurve, target: Multiplier): number {
  return firstTickWhere(curve, (recognized) => recognized >= target, target);
}

/** First tick whose recognized multiplier is `> crashPoint`: the round is over from this tick on. */
export function crashTick(curve: MultiplierCurve, crashPoint: Multiplier): number {
  return firstTickWhere(curve, (recognized) => recognized > crashPoint, crashPoint);
}

function firstTickWhere(
  curve: MultiplierCurve,
  predicate: (recognized: Multiplier) => boolean,
  bound: Multiplier,
): number {
  if (bound < ONE_X || bound > curve.maxMultiplier) {
    throw new RangeError("multiplier must be within [1.00x, maxMultiplier]");
  }
  // The recognized curve is non-decreasing, so the predicate is monotone over ticks.
  let low = 0;
  let high = curve.points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (predicate(truncateToCenti(curve.points[mid]))) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}
