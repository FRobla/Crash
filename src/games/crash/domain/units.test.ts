import { describe, expect, it } from "vitest";
import {
  assertValidMaxMultiplier,
  isCentiPrecise,
  MAX_SUPPORTED_MULTIPLIER,
  payoutFor,
  truncateToCenti,
} from "./units";

describe("truncateToCenti", () => {
  it("drops sub-hundredth precision", () => {
    expect(truncateToCenti(10_299n)).toBe(10_200n);
    expect(truncateToCenti(10_200n)).toBe(10_200n);
    expect(isCentiPrecise(10_200n)).toBe(true);
    expect(isCentiPrecise(10_201n)).toBe(false);
  });
});

describe("payoutFor", () => {
  it("floors toward the house", () => {
    expect(payoutFor(1_000n, 15_000n)).toBe(1_500n);
    expect(payoutFor(3n, 10_100n)).toBe(3n);
    expect(payoutFor(99n, 10_100n)).toBe(99n);
    expect(payoutFor(100n, 10_100n)).toBe(101n);
  });

  it("stays exact for amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const stake = 9_007_199_254_740_993n;
    expect(payoutFor(stake, 20_000n)).toBe(18_014_398_509_481_986n);
  });

  it("rejects negative inputs", () => {
    expect(() => payoutFor(-1n, 10_000n)).toThrow(RangeError);
    expect(() => payoutFor(1n, -1n)).toThrow(RangeError);
  });
});

describe("assertValidMaxMultiplier", () => {
  it.each([10_100n, 1_000_000n, MAX_SUPPORTED_MULTIPLIER])("accepts %s", (value) => {
    expect(() => assertValidMaxMultiplier(value)).not.toThrow();
  });

  it.each([10_000n, 10_101n, MAX_SUPPORTED_MULTIPLIER + 100n])("rejects %s", (value) => {
    expect(() => assertValidMaxMultiplier(value)).toThrow(RangeError);
  });
});
