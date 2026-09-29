"use client";

import { useEffect, useState } from "react";
import type { CrashGamePort } from "./crash-game";

/** Re-reads the projected tick a few times per second so the live view keeps moving. */
export function useEstimatedTick(game: Pick<CrashGamePort, "estimatedTick">, intervalMs = 100): bigint | null {
  const [tick, setTick] = useState<bigint | null>(() => game.estimatedTick());
  useEffect(() => {
    const id = setInterval(() => setTick(game.estimatedTick()), intervalMs);
    return () => clearInterval(id);
  }, [game, intervalMs]);
  return tick;
}
