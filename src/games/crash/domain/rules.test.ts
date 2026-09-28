import { describe, expect, it } from "vitest";
import { assertValidCrashPointParams } from "./crash-point";
import { createMultiplierCurve } from "./multiplier-curve";
import { CRASH_RULES_V1 } from "./rules";

describe("CRASH_RULES_V1", () => {
  it("holds the parameters approved for devnet", () => {
    expect(CRASH_RULES_V1).toEqual({
      version: 1,
      houseEdgeBps: 300n,
      growthPpm: 24_000n,
      maxMultiplier: 1_000_000n,
    });
  });

  it("is valid and yields a 196-tick curve", () => {
    expect(() => assertValidCrashPointParams(CRASH_RULES_V1)).not.toThrow();
    expect(createMultiplierCurve(CRASH_RULES_V1.growthPpm, CRASH_RULES_V1.maxMultiplier).points).toHaveLength(196);
  });

  it("is immutable", () => {
    expect(Object.isFrozen(CRASH_RULES_V1)).toBe(true);
  });
});
