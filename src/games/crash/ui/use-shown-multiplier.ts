"use client";

import { ONE_X, type Multiplier } from "../domain/units";
import type { CrashGamePort, LiveRound } from "./crash-game";
import { shownMultiplier } from "./live-intensity";
import { presentationLag } from "./presentation-lag";
import { useFrameValue, useReducedMotion } from "./use-frame-value";

/**
 * The running multiplier as shown, re-read every animation frame while `active`. Every surface
 * that shows the live multiplier uses this, so they never disagree. Presentation only.
 */
export function useShownMultiplier(
  round: Pick<LiveRound, "roundId" | "rulesVersion" | "startTick" | "crashPoint"> | null,
  game: Pick<CrashGamePort, "projectedTick">,
  active: boolean,
): Multiplier {
  const reduced = useReducedMotion();
  return useFrameValue(
    () => (round ? shownMultiplier(round, game.projectedTick(), reduced, presentationLag.forRound(round.roundId)) : ONE_X),
    active,
  );
}
