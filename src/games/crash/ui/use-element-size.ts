"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Tracks an element's content box so SVG charts draw in real pixels (crisp text, true strokes).
 * `null` until measured on the client, so nothing is drawn at a guessed size.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setSize((previous) => (previous?.width === width && previous?.height === height ? previous : { width, height }));
      }
    };
    // Measure before the first paint.
    const bounds = element.getBoundingClientRect();
    update(bounds.width, bounds.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width, entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
