"use client";

import { useEffect, useState } from "react";
import type { CrashGamePort } from "./crash-game";
import { playoutRound, presentationLag, presentedTick } from "./presentation-lag";
import type { ShownRound } from "./round-view";

function sameShown(a: ShownRound, b: ShownRound): boolean {
  return (
    a.roundId === b.roundId &&
    a.phase === b.phase &&
    a.startTick === b.startTick &&
    a.crashPoint === b.crashPoint &&
    a.crashTick === b.crashTick &&
    a.provisional === b.provisional
  );
}

const knownCrash = (round: ShownRound) =>
  (round.phase === "crashed" || round.phase === "settled") && round.crashPoint !== null && round.crashTick !== null;

/**
 * The round as the console shows it: a crash known before the lagged curve reaches it keeps
 * playing out as running, capped at the crash point, and shows as crashed once the curve gets
 * there, even if the next round has opened meanwhile (the crank opens it right after the reveal).
 * Also measures how late each crash arrives, which sets the lag of later rounds.
 */
export function usePlayout(round: ShownRound | null, game: Pick<CrashGamePort, "projectedTick" | "msPerTick">): ShownRound | null {
  const [flips, setFlips] = useState(0);
  // The latest state of the last round this console saw running; only such a round is played out.
  const [tracked, setTracked] = useState<ShownRound | null>(null);
  const follows = round !== null && (round.phase === "running" || tracked?.roundId === round.roundId);
  if (follows && (tracked === null || !sameShown(tracked, round))) setTracked(round);
  const current = follows ? round : tracked;

  // A newer round waits until the tracked crash has played out and shown as crashed once.
  const superseded = tracked !== null && round !== null && round.roundId > tracked.roundId;
  const projected = game.projectedTick();
  const lag = current === null ? 0 : presentationLag.forRound(current.roundId);
  const played = current !== null && knownCrash(current) ? playoutRound(current, projected, lag, true) : null;
  const playingOut = played !== null && played !== current;
  const shown = superseded ? (played ?? round) : follows ? (played ?? round) : round;

  // Once the superseded crash is due, hand over to the newer round. This render still returns the
  // crash, so the console's crash hold (updated in this same render) keeps it on screen.
  if (superseded && played !== null && !playingOut) setTracked(null);

  const roundId = current?.roundId ?? null;
  const startTick = current?.startTick ?? null;
  const crashTick = current?.crashTick ?? null;
  const known = current !== null && knownCrash(current);
  useEffect(() => {
    if (!known || roundId === null || startTick === null || crashTick === null) return;
    const now = game.projectedTick();
    // A hidden tab runs its timers late: its samples would say nothing about the network.
    if (now === null || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    presentationLag.record(roundId, now - Number(startTick) - Number(crashTick));
    // `game` is a fresh object every render; the sample is taken once, when the crash is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, roundId, startTick, crashTick]);

  useEffect(() => {
    if (!playingOut || startTick === null || crashTick === null) return;
    const now = game.projectedTick();
    const ticksLeft = now === null ? 0 : Number(crashTick) - presentedTick(startTick, now, lag);
    const id = setTimeout(() => setFlips((n) => n + 1), Math.max(0, ticksLeft * game.msPerTick()) + 16);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingOut, roundId, startTick, crashTick, lag, flips]);

  return shown;
}
