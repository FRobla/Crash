"use client";

import { useEffect, useRef, useState } from "react";
import type { CrashGamePort } from "./crash-game";
import { APPROX_SECONDS_PER_TICK } from "./round-view";

export interface LiveClock {
  /** Projected settlement tick, as the port reports it. */
  tick: bigint | null;
  /**
   * Visual progress towards the next tick in [0, 1), only to animate the chart smoothly between
   * slots. It never feeds a multiplier that is shown as a number, offered or paid.
   */
  fraction: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Reads the projected tick once per animation frame while `smooth` (a round is running) and a
 * few times per second otherwise. Reduced-motion users get whole ticks only.
 */
export function useLiveClock(game: Pick<CrashGamePort, "estimatedTick">, smooth: boolean): LiveClock {
  // The port object changes identity on every state refresh; the loop must not restart with it.
  const gameRef = useRef(game);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);
  const [clock, setClock] = useState<LiveClock>(() => ({ tick: game.estimatedTick(), fraction: 0 }));

  useEffect(() => {
    const animate = smooth && !prefersReducedMotion();
    let lastTick: bigint | null = null;
    let changedAt = 0;
    const step = () => {
      const tick = gameRef.current.estimatedTick();
      const now = performance.now();
      if (tick !== lastTick) {
        lastTick = tick;
        changedAt = now;
      }
      const fraction = animate ? Math.min(0.999, (now - changedAt) / (APPROX_SECONDS_PER_TICK * 1000)) : 0;
      setClock((previous) => (previous.tick === tick && previous.fraction === fraction ? previous : { tick, fraction }));
    };
    if (animate && typeof requestAnimationFrame === "function") {
      let frame = 0;
      const loop = () => {
        step();
        frame = requestAnimationFrame(loop);
      };
      loop();
      return () => cancelAnimationFrame(frame);
    }
    step();
    const id = setInterval(step, 100);
    return () => clearInterval(id);
  }, [smooth]);

  return clock;
}
