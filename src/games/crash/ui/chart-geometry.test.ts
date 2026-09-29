import { describe, expect, it } from "vitest";
import { createMultiplierCurve } from "../domain/multiplier-curve";
import { CRASH_RULES_V1 } from "../domain/rules";
import {
  axisMultiplierLabel,
  chartDomains,
  curveSamples,
  lastTickAtOrBelow,
  logRatio,
  niceStep,
  niceTicks,
} from "./chart-geometry";

const curve = createMultiplierCurve(CRASH_RULES_V1.growthPpm, CRASH_RULES_V1.maxMultiplier);

describe("chart geometry", () => {
  it("picks nice steps and ticks inside the domain", () => {
    expect(niceStep(1, 4)).toBe(0.25);
    expect(niceStep(9, 5)).toBe(2);
    expect(niceStep(0, 5)).toBe(1);
    expect(niceTicks({ min: 1, max: 2 }, 4)).toEqual([1, 1.25, 1.5, 1.75, 2]);
    expect(niceTicks({ min: 0, max: 20 }, 5)).toEqual([0, 5, 10, 15, 20]);
  });

  it("keeps headroom ahead of the curve and never shrinks below the minimum view", () => {
    expect(chartDomains(0, 1)).toEqual({ x: { min: 0, max: 20 }, y: { min: 1, max: 2 } });
    const grown = chartDomains(100, 10);
    expect(grown.x.max).toBeGreaterThan(100);
    expect(grown.y.max).toBeGreaterThan(10);
  });

  it("samples the curve with an interpolated tip that stays below the next tick", () => {
    const samples = curveSamples(curve, 10, 0.5);
    expect(samples).toHaveLength(12);
    expect(samples[0]).toEqual({ tick: 0, value: 1 });
    const tip = samples[11];
    expect(tip.tick).toBe(10.5);
    expect(tip.value).toBeGreaterThan(samples[10].value);
    expect(tip.value).toBeLessThan(Number(curve.points[11]) / 10_000);
  });

  it("ends a revealed curve exactly at the crash point", () => {
    const crashPoint = 20_000n;
    const last = lastTickAtOrBelow(curve, crashPoint);
    expect(curve.points[last]).toBeLessThanOrEqual(crashPoint);
    expect(curve.points[last + 1]).toBeGreaterThan(crashPoint);
    const samples = curveSamples(curve, last + 5, 0, crashPoint);
    expect(samples.at(-1)?.value).toBe(2);
    expect(samples.every((sample) => sample.value <= 2)).toBe(true);
  });

  it("scales crash-point bars logarithmically and labels axes compactly", () => {
    expect(logRatio(1, 100)).toBe(0);
    expect(logRatio(10, 100)).toBeCloseTo(0.5);
    expect(logRatio(1_000, 100)).toBe(1);
    expect(axisMultiplierLabel(1.5)).toBe("1.5x");
    expect(axisMultiplierLabel(2)).toBe("2x");
  });
});
