import type { MultiplierCurve } from "../domain/multiplier-curve";
import { MULTIPLIER_SCALE, type Multiplier } from "../domain/units";

/**
 * Pure geometry for the live chart and the crash-point bars. Presentation only: these numbers
 * place pixels and are never used for amounts, payouts or any decision.
 */

export interface Domain {
  min: number;
  max: number;
}

export interface CurvePoint {
  /** Round-relative tick, possibly fractional at the animated tip. */
  tick: number;
  /** Multiplier as a plain number (1 = 1.00x). */
  value: number;
}

const NICE_FACTORS = [1, 2, 2.5, 5, 10];

/** Smallest "nice" step (1, 2, 2.5, 5 × 10ⁿ) that splits `span` into at most `maxTicks` parts. */
export function niceStep(span: number, maxTicks: number): number {
  if (!(span > 0) || maxTicks < 1) return 1;
  const raw = span / maxTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = NICE_FACTORS.find((candidate) => candidate * magnitude >= raw) ?? 10;
  return factor * magnitude;
}

/** Tick values inside `[domain.min, domain.max]` on multiples of a nice step. */
export function niceTicks(domain: Domain, maxTicks: number): number[] {
  const step = niceStep(domain.max - domain.min, maxTicks);
  const ticks: number[] = [];
  for (let value = Math.ceil(domain.min / step) * step; value <= domain.max + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

/** Domains that always leave headroom ahead of the curve, so it keeps "climbing" on screen. */
export function chartDomains(lastTick: number, peak: number, minTicks = 20): { x: Domain; y: Domain } {
  return {
    x: { min: 0, max: Math.max(minTicks, lastTick * 1.18) },
    y: { min: 1, max: Math.max(2, 1 + (peak - 1) * 1.25) },
  };
}

export function toNumber(multiplier: Multiplier): number {
  return Number(multiplier) / Number(MULTIPLIER_SCALE);
}

/**
 * Multiplier at a fractional tick, interpolated exponentially between the curve's points (the
 * curve itself grows exponentially). Presentation only: never offered, paid or compared.
 */
export function interpolatedMultiplier(curve: MultiplierCurve, tick: number): number {
  const horizon = curve.points.length - 1;
  if (!(tick > 0)) return toNumber(curve.points[0]);
  if (tick >= horizon) return toNumber(curve.points[horizon]);
  const index = Math.floor(tick);
  const from = toNumber(curve.points[index]);
  const to = toNumber(curve.points[index + 1]);
  return from * (to / from) ** (tick - index);
}

/**
 * Curve samples from tick 0 to a possibly fractional `tick`, whose fraction becomes an
 * interpolated tip. `cap` stops the curve at a crash point.
 */
export function curveSamples(curve: MultiplierCurve, tick: number, cap: Multiplier | null = null): CurvePoint[] {
  const horizon = curve.points.length - 1;
  const lastTick = Math.max(0, tick);
  const fraction = lastTick - Math.floor(lastTick);
  const end = Math.max(0, Math.min(Math.floor(lastTick), horizon));
  const samples: CurvePoint[] = [];
  for (let tick = 0; tick <= end; tick++) {
    const raw = curve.points[tick];
    if (cap !== null && raw > cap) {
      // End where the segment towards this tick crosses the cap, not on a flat step.
      const previous = curve.points[tick - 1] ?? raw;
      const crossing = raw === previous ? 0 : Number(cap - previous) / Number(raw - previous);
      samples.push({ tick: tick - 1 + Math.max(0, Math.min(1, crossing)), value: toNumber(cap) });
      return samples;
    }
    samples.push({ tick, value: toNumber(raw) });
  }
  if (fraction > 0 && end < horizon) {
    const value = interpolatedMultiplier(curve, end + fraction);
    if (cap === null || value <= toNumber(cap)) samples.push({ tick: end + fraction, value });
  }
  return samples;
}

/** Last tick whose raw multiplier does not exceed `crashPoint` (where the drawn curve ends). */
export function lastTickAtOrBelow(curve: MultiplierCurve, crashPoint: Multiplier): number {
  let tick = 0;
  while (tick + 1 < curve.points.length && curve.points[tick + 1] <= crashPoint) tick++;
  return tick;
}

/** Height ratio for a crash-point bar on a log scale, so 1.2x and 80x fit in one chart. */
export function logRatio(value: number, max: number): number {
  if (!(value > 1) || !(max > 1)) return 0;
  return Math.min(1, Math.log(value) / Math.log(max));
}

/** Short axis label: `1.5x`, `2x`, `10x`. */
export function axisMultiplierLabel(value: number): string {
  return `${Number(value.toFixed(2))}x`;
}
