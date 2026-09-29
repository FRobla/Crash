import { describe, expect, it } from "vitest";
import { CRASH_RULES_V1 } from "../domain/rules";
import { ONE_X } from "../domain/units";
import { intensity, intensityTier, lastMilestone, shownMultiplier } from "./live-intensity";
import { multiplierAt } from "./round-view";

const round = { rulesVersion: CRASH_RULES_V1.version, startTick: 1_000n, crashPoint: null };
const LAG = 3;

describe("shownMultiplier", () => {
  it("is 1.00x before the round starts or without a clock", () => {
    expect(shownMultiplier({ ...round, startTick: null }, 1_010, false, LAG)).toBe(ONE_X);
    expect(shownMultiplier(round, null, false, LAG)).toBe(ONE_X);
    expect(shownMultiplier(round, 990, false, LAG)).toBe(ONE_X);
  });

  it("is hundredth-precise, trails by the presentation lag and never exceeds the next whole tick", () => {
    for (let tenth = 0; tenth < 400; tenth++) {
      const projected = 1_000 + tenth / 10;
      const shown = shownMultiplier(round, projected, false, LAG);
      expect(shown % 100n).toBe(0n);
      const relative = Math.max(0, projected - 1_000 - LAG);
      expect(shown).toBeLessThanOrEqual(multiplierAt(CRASH_RULES_V1, BigInt(Math.ceil(relative))));
    }
  });

  it("never goes backwards as the projection advances", () => {
    let previous = 0n;
    for (let tenth = 0; tenth < 600; tenth++) {
      const shown = shownMultiplier(round, 1_000 + tenth / 10, false, LAG);
      expect(shown).toBeGreaterThanOrEqual(previous);
      previous = shown;
    }
  });

  it("never shows more than a crash point already known", () => {
    const crashed = { ...round, crashPoint: ONE_X };
    for (let tenth = 0; tenth < 400; tenth++) {
      expect(shownMultiplier(crashed, 1_000 + tenth / 10, false, LAG)).toBe(ONE_X);
      expect(shownMultiplier(crashed, 1_000 + tenth / 10, true, LAG)).toBe(ONE_X);
    }
    expect(shownMultiplier({ ...round, crashPoint: 15_000n }, 1_100, false, LAG)).toBe(15_000n);
  });

  it("shows whole ticks only with reduced motion", () => {
    expect(shownMultiplier(round, 1_030.9, true, LAG)).toBe((multiplierAt(CRASH_RULES_V1, 27n) / 100n) * 100n);
  });
});

describe("intensity", () => {
  it("bands the multiplier by color tier", () => {
    expect(intensityTier(19_999n)).toBe("calm");
    expect(intensityTier(20_000n)).toBe("warm");
    expect(intensityTier(99_999n)).toBe("warm");
    expect(intensityTier(100_000n)).toBe("hot");
  });

  it("reports the highest milestone reached", () => {
    expect(lastMilestone(19_900n)).toBeNull();
    expect(lastMilestone(20_000n)).toBe(20_000n);
    expect(lastMilestone(123_400n)).toBe(100_000n);
    expect(lastMilestone(1_000_000n)).toBe(1_000_000n);
  });

  it("grows on a log scale from 0 at 1x to 1 at 100x", () => {
    expect(intensity(ONE_X)).toBe(0);
    expect(intensity(100_000n)).toBeCloseTo(0.5);
    expect(intensity(1_000_000n)).toBe(1);
    expect(intensity(10_000_000n)).toBe(1);
  });
});
