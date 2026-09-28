import { describe, expect, it } from "vitest";
import { betExposure, validateBet, validateRoundExposure, type BetLimits } from "./limits";

const maxMultiplier = 1_000_000n; // 100x
const limits: BetLimits = {
  minStake: 1_000n,
  maxStake: 50_000n,
  maxPayout: 2_000_000n,
  maxRoundExposure: 5_000_000n,
};

describe("validateBet", () => {
  it("accepts the exact stake bounds", () => {
    expect(validateBet({ stake: 1_000n, autoCashOut: 20_000n }, limits, maxMultiplier)).toEqual({
      ok: true,
      value: 2_000n,
    });
    expect(validateBet({ stake: 20_000n, autoCashOut: null }, limits, maxMultiplier)).toEqual({
      ok: true,
      value: 2_000_000n,
    });
  });

  it.each([
    [{ stake: 999n, autoCashOut: null }, "stake-below-minimum"],
    [{ stake: 50_001n, autoCashOut: 20_000n }, "stake-above-maximum"],
    [{ stake: 1_000n, autoCashOut: 15_050n }, "auto-cash-out-not-centi-precise"],
    [{ stake: 1_000n, autoCashOut: 10_000n }, "auto-cash-out-below-minimum"],
    [{ stake: 1_000n, autoCashOut: 1_000_100n }, "auto-cash-out-above-maximum"],
    [{ stake: 20_001n, autoCashOut: null }, "payout-above-maximum"],
    [{ stake: 50_000n, autoCashOut: 400_100n }, "payout-above-maximum"],
  ] as const)("rejects %o with %s", (bet, reason) => {
    expect(validateBet(bet, limits, maxMultiplier)).toEqual({ ok: false, error: reason });
  });

  it("accepts the smallest and largest auto cash-out targets", () => {
    expect(validateBet({ stake: 1_000n, autoCashOut: 10_100n }, limits, maxMultiplier).ok).toBe(true);
    expect(validateBet({ stake: 1_000n, autoCashOut: maxMultiplier }, limits, maxMultiplier).ok).toBe(true);
  });

  it("rejects invalid limit configurations", () => {
    expect(() =>
      validateBet({ stake: 1n, autoCashOut: null }, { ...limits, minStake: 0n }, maxMultiplier),
    ).toThrow(RangeError);
    expect(() =>
      validateBet({ stake: 1n, autoCashOut: null }, { ...limits, maxStake: 999n }, maxMultiplier),
    ).toThrow(RangeError);
  });
});

describe("betExposure", () => {
  it("uses the auto target when set and the maximum multiplier otherwise", () => {
    expect(betExposure({ stake: 1_000n, autoCashOut: 25_000n }, maxMultiplier)).toBe(2_500n);
    expect(betExposure({ stake: 1_000n, autoCashOut: null }, maxMultiplier)).toBe(100_000n);
  });
});

describe("validateRoundExposure", () => {
  it("accepts exposure up to the limit and rejects one base unit more", () => {
    expect(validateRoundExposure(4_000_000n, 1_000_000n, limits)).toEqual({ ok: true, value: 5_000_000n });
    expect(validateRoundExposure(4_000_000n, 1_000_001n, limits)).toEqual({
      ok: false,
      error: "round-exposure-exceeded",
    });
  });
});
