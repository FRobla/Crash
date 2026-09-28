import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  crashTick,
  createMultiplierCurve,
  firstTickAtLeast,
  multiplierAtTick,
  recognizedMultiplierAtTick,
} from "./multiplier-curve";

const curve = createMultiplierCurve(24_000n, 1_000_000n);

describe("createMultiplierCurve", () => {
  it("matches golden values", () => {
    expect(multiplierAtTick(curve, 0)).toBe(10_000n);
    expect(multiplierAtTick(curve, 1)).toBe(10_240n);
    expect(multiplierAtTick(curve, 2)).toBe(10_485n);
    expect(multiplierAtTick(curve, 3)).toBe(10_736n);
    expect(multiplierAtTick(curve, 10)).toBe(12_672n);
    expect(multiplierAtTick(curve, 30)).toBe(20_349n);
    expect(recognizedMultiplierAtTick(curve, 30)).toBe(20_300n);
  });

  it("stops at the first tick whose recognized multiplier exceeds the maximum", () => {
    expect(curve.points).toHaveLength(196);
    expect(recognizedMultiplierAtTick(curve, 195)).toBeGreaterThan(1_000_000n);
    expect(recognizedMultiplierAtTick(curve, 194)).toBeLessThanOrEqual(1_000_000n);
  });

  it("is strictly increasing for any valid growth", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 1_000_000n }), (growthPpm) => {
        const { points } = createMultiplierCurve(growthPpm, 100_000n);
        return points.every((point, tick) => tick === 0 || point > points[tick - 1]);
      }),
      { numRuns: 50 },
    );
  });

  it.each([
    [999n, 1_000_000n],
    [1_000_001n, 1_000_000n],
    [24_000n, 10_050n],
  ])("rejects growth %s with maximum %s", (growthPpm, maxMultiplier) => {
    expect(() => createMultiplierCurve(growthPpm, maxMultiplier)).toThrow(RangeError);
  });

  it.each([-1, 196, 1.5, Number.NaN])("rejects tick %s outside the horizon", (tick) => {
    expect(() => multiplierAtTick(curve, tick)).toThrow(RangeError);
  });
});

describe("crashTick", () => {
  it("is the first tick whose recognized multiplier exceeds the crash point", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 100n, max: 10_000n }), (centi) => {
        const crashPoint = centi * 100n;
        const tick = crashTick(curve, crashPoint);
        return (
          recognizedMultiplierAtTick(curve, tick) > crashPoint &&
          (tick === 0 || recognizedMultiplierAtTick(curve, tick - 1) <= crashPoint)
        );
      }),
    );
  });

  it("gives 1.00x rounds a single tick at 1.00x", () => {
    expect(crashTick(curve, 10_000n)).toBe(1);
  });

  it("rejects crash points outside [1.00x, maxMultiplier]", () => {
    expect(() => crashTick(curve, 9_900n)).toThrow(RangeError);
    expect(() => crashTick(curve, 1_000_100n)).toThrow(RangeError);
  });
});

describe("firstTickAtLeast", () => {
  it("is the first tick whose recognized multiplier reaches the target", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 101n, max: 10_000n }), (centi) => {
        const target = centi * 100n;
        const tick = firstTickAtLeast(curve, target);
        return (
          recognizedMultiplierAtTick(curve, tick) >= target &&
          recognizedMultiplierAtTick(curve, tick - 1) < target
        );
      }),
    );
  });
});
