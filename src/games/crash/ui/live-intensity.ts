import { rulesForVersion } from "../domain/rules";
import { CENTI_STEP, ONE_X, type Multiplier } from "../domain/units";
import { interpolatedMultiplier, toNumber } from "./chart-geometry";
import type { LiveRound } from "./crash-game";
import { presentedTick } from "./presentation-lag";
import { curveForRules, multiplierAt } from "./round-view";

/**
 * Presentation of the running multiplier (spec crash-client-v1 §5.2): the one value the headline,
 * the curve tip and the cash-out button all show, and how "intense" it looks. Never offered,
 * paid or compared: offers and results stay on whole ticks.
 */

/**
 * Multiplier shown for a running round at a fractional projected tick, `lagTicks` behind it (the
 * playout buffer, see presentation-lag.ts), truncated to hundredths so it never shows more than
 * the curve reached, and never more than a crash point already known. With reduced motion, whole
 * ticks only.
 */
export function shownMultiplier(
  round: Pick<LiveRound, "rulesVersion" | "startTick" | "crashPoint">,
  projectedTick: number | null,
  reduced: boolean,
  lagTicks: number,
): Multiplier {
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules || projectedTick === null || round.startTick === null) return ONE_X;
  const relative = presentedTick(round.startTick, projectedTick, lagTicks);
  const shown = reduced
    ? (multiplierAt(rules, BigInt(Math.floor(relative))) / CENTI_STEP) * CENTI_STEP
    : BigInt(Math.max(100, Math.floor(interpolatedMultiplier(curveForRules(rules), relative) * 100))) * CENTI_STEP;
  return round.crashPoint !== null && round.crashPoint < shown ? round.crashPoint : shown;
}

export type IntensityTier = "calm" | "warm" | "hot";

/** Color band of a running multiplier: < 2x calm, 2–10x warm, ≥ 10x hot (red is the crash's). */
export function intensityTier(multiplier: Multiplier): IntensityTier {
  if (multiplier >= 10n * ONE_X) return "hot";
  if (multiplier >= 2n * ONE_X) return "warm";
  return "calm";
}

export const MILESTONES: readonly Multiplier[] = [2n, 5n, 10n, 25n, 50n, 100n].map((x) => x * ONE_X);

/** Highest milestone the multiplier has reached, or null below the first. */
export function lastMilestone(multiplier: Multiplier): Multiplier | null {
  let reached: Multiplier | null = null;
  for (const milestone of MILESTONES) if (multiplier >= milestone) reached = milestone;
  return reached;
}

/** How much the headline grows with the multiplier: 0 at 1x, 1 at 100x and above (log scale). */
export function intensity(multiplier: Multiplier): number {
  const value = toNumber(multiplier);
  if (!(value > 1)) return 0;
  return Math.min(1, Math.log10(value) / 2);
}
