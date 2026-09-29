/**
 * Measured slot clock (docs/specs/crash-client-v1.md §5.1). Solana slots are nominally 400 ms, but
 * devnet runs at ≈ 230 ms, so every countdown, axis and expiry uses a measured duration instead.
 * Pure: callers pass the time, so it runs the same in the browser, the crank and tests.
 */

export const NOMINAL_MS_PER_SLOT = 400;
export const MIN_MS_PER_SLOT = 150;
export const MAX_MS_PER_SLOT = 600;
/** Observations older than this do not feed the rate. */
const WINDOW_MS = 15_000;
/** The regression needs this many observations spanning this long before it replaces the baseline. */
const MIN_FIT_OBSERVATIONS = 4;
const MIN_FIT_SPAN_MS = 3_000;
/** Beyond this error the projection jumps; below it, it only changes speed. */
const JUMP_SLOTS = 8;
/** Errors are corrected over roughly this many slots. */
const CORRECTION_SLOTS = 2;
const MIN_SPEED = 0.5;
const MAX_SPEED = 1.5;

export function clampMsPerSlot(ms: number): number {
  if (!Number.isFinite(ms)) return NOMINAL_MS_PER_SLOT;
  return Math.min(MAX_MS_PER_SLOT, Math.max(MIN_MS_PER_SLOT, ms));
}

export interface PerformanceSample {
  numSlots: number;
  samplePeriodSecs: number;
}

/** Average slot duration from `getRecentPerformanceSamples`, or null without usable samples. */
export function msPerSlotFromSamples(samples: readonly PerformanceSample[]): number | null {
  let slots = 0;
  let seconds = 0;
  for (const sample of samples) {
    if (sample.numSlots > 0 && sample.samplePeriodSecs > 0) {
      slots += sample.numSlots;
      seconds += sample.samplePeriodSecs;
    }
  }
  return slots > 0 ? clampMsPerSlot((seconds * 1000) / slots) : null;
}

interface Observation {
  slot: number;
  at: number;
}

export class SlotClock {
  private observations: Observation[] = [];
  private baseline: number;
  private fitted: number | null = null;
  private shown: { value: number; at: number } | null = null;

  constructor(initialMsPerSlot = NOMINAL_MS_PER_SLOT) {
    this.baseline = clampMsPerSlot(initialMsPerSlot);
  }

  /** Baseline rate (e.g. from performance samples), used until enough observations exist. */
  setBaseline(msPerSlot: number): void {
    this.baseline = clampMsPerSlot(msPerSlot);
  }

  msPerSlot(): number {
    return this.fitted ?? this.baseline;
  }

  /** Records that the cluster was at `slot` at time `at` (ms). Out-of-order slots are ignored. */
  observe(slot: bigint | number, at: number): void {
    const value = Number(slot);
    const last = this.observations.at(-1);
    if (last && (value < last.slot || at <= last.at)) return;
    this.observations.push({ slot: value, at });
    this.observations = this.observations.filter((observation) => at - observation.at <= WINDOW_MS);
    this.fitted = this.fit();
  }

  /** Where the cluster should be now according to the observations (may jitter). */
  target(at: number): number | null {
    const last = this.observations.at(-1);
    if (!last) return null;
    return last.slot + (at - last.at) / this.msPerSlot();
  }

  /**
   * Continuous projection of the slot at time `at` for presentation. It moves forward at the
   * measured rate, corrects errors by running 0.5×–1.5× as fast, and only jumps (possibly
   * backwards) when the error exceeds 8 slots or after `resync`.
   */
  project(at: number): number | null {
    const target = this.target(at);
    if (target === null) return null;
    if (!this.shown || at < this.shown.at) {
      this.shown = { value: target, at };
      return target;
    }
    const step = (at - this.shown.at) / this.msPerSlot();
    const naive = this.shown.value + step;
    const error = target - naive;
    let value: number;
    if (Math.abs(error) > JUMP_SLOTS) value = target;
    else {
      const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, 1 + error / CORRECTION_SLOTS));
      value = this.shown.value + step * speed;
    }
    this.shown = { value, at };
    return value;
  }

  /** Forgets the smoothed position so the next projection starts on the target (phase change). */
  resync(): void {
    this.shown = null;
  }

  /** Least-squares slope of slot over time, as ms per slot. */
  private fit(): number | null {
    const points = this.observations;
    if (points.length < MIN_FIT_OBSERVATIONS) return null;
    if (points[points.length - 1].at - points[0].at < MIN_FIT_SPAN_MS) return null;
    const t0 = points[0].at;
    const s0 = points[0].slot;
    const meanT = points.reduce((sum, p) => sum + (p.at - t0), 0) / points.length;
    const meanS = points.reduce((sum, p) => sum + (p.slot - s0), 0) / points.length;
    let numerator = 0;
    let denominator = 0;
    for (const point of points) {
      const dt = point.at - t0 - meanT;
      numerator += dt * (point.slot - s0 - meanS);
      denominator += dt * dt;
    }
    if (numerator <= 0 || denominator === 0) return null;
    return clampMsPerSlot(denominator / numerator);
  }
}
