"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Presentation clock (spec crash-client-v1 §5.2): leaf components (curve, headline, countdown)
 * subscribe to animation frames themselves, so only they re-render at 60 Hz. Users who ask for
 * reduced motion get a few updates per second instead.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION).matches === true,
    () => false,
  );
}

/**
 * Re-reads `read()` every animation frame while `active` (every `slowMs` with reduced motion or
 * without `requestAnimationFrame`), re-rendering only when the value changes.
 */
export function useFrameValue<T>(read: () => T, active: boolean, slowMs = 250): T {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);
  const [value, setValue] = useState<T>(read);
  const reduced = useReducedMotion();

  useEffect(() => {
    const step = () => {
      const next = readRef.current();
      setValue((previous) => (Object.is(previous, next) ? previous : next));
    };
    step();
    if (!active) return;
    if (!reduced && typeof requestAnimationFrame === "function") {
      let frame = 0;
      const loop = () => {
        step();
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(frame);
    }
    const id = setInterval(step, slowMs);
    return () => clearInterval(id);
  }, [active, reduced, slowMs]);

  return value;
}
