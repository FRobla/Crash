import type { ShownRound } from "./round-view";

/**
 * Playout buffer of the running multiplier (spec crash-client-v1 §5.2). The crash point reaches
 * the web only after the reveal (or its preflight, ADR 0004), some ticks after the crash tick; the
 * headline and the curve trail the slot projection by at least that delay, so a crash is known
 * before the curve gets there and the shown multiplier never passes the crash point. Presentation
 * only: offers and results stay on whole, unlagged ticks.
 */

/** Lag before any crash was observed in this session (≈ 1.4 s at the measured devnet slot). */
export const DEFAULT_LAG_TICKS = 6;
export const MIN_LAG_TICKS = 1;
/** Bounds how far the headline may trail (≈ 3.7 s), whatever the latency observed. */
export const MAX_LAG_TICKS = 16;
/** The lag covers the slowest crash among this many recent rounds. */
export const LAG_SAMPLE_WINDOW = 20;
const MAX_TRACKED_ROUNDS = 64;

function remember<T>(map: Map<bigint, T>, key: bigint, value: T): void {
  map.set(key, value);
  if (map.size > MAX_TRACKED_ROUNDS) map.delete(map.keys().next().value!);
}

export class PresentationLag {
  private samples: number[] = [];
  private lagByRound = new Map<bigint, number>();
  private sampled = new Map<bigint, true>();

  /** Current lag in ticks: the slowest recent crash, rounded up and bounded. */
  current(): number {
    if (this.samples.length === 0) return DEFAULT_LAG_TICKS;
    return Math.min(MAX_LAG_TICKS, Math.max(MIN_LAG_TICKS, Math.ceil(Math.max(...this.samples))));
  }

  /** Lag of a round, fixed at its first use so a new sample never moves a round already shown. */
  forRound(roundId: bigint): number {
    let lag = this.lagByRound.get(roundId);
    if (lag === undefined) {
      lag = this.current();
      remember(this.lagByRound, roundId, lag);
    }
    return lag;
  }

  /** How many ticks after its crash tick a round's crash became known. Counted once per round. */
  record(roundId: bigint, lateTicks: number): void {
    if (this.sampled.has(roundId) || !Number.isFinite(lateTicks)) return;
    remember(this.sampled, roundId, true);
    this.samples.push(Math.max(0, lateTicks));
    if (this.samples.length > LAG_SAMPLE_WINDOW) this.samples.shift();
  }
}

/** Shared by every surface that shows the live multiplier, so they never disagree. */
export const presentationLag = new PresentationLag();

/** Relative tick shown for a round: the projection minus the lag, never before the start. */
export function presentedTick(startTick: bigint, projectedTick: number, lagTicks: number): number {
  return Math.max(0, projectedTick - Number(startTick) - lagTicks);
}

/**
 * A crashed round the console saw running keeps showing as running (with its crash point known,
 * which caps the curve and the headline) until the lagged curve reaches the crash tick.
 */
export function playoutRound(round: ShownRound | null, projectedTick: number | null, lagTicks: number, sawRunning: boolean): ShownRound | null {
  if (!round || !sawRunning || projectedTick === null) return round;
  if (round.phase !== "crashed" && round.phase !== "settled") return round;
  if (round.startTick === null || round.crashTick === null || round.crashPoint === null) return round;
  if (presentedTick(round.startTick, projectedTick, lagTicks) >= Number(round.crashTick)) return round;
  return { ...round, phase: "running" };
}
