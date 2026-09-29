import { describe, expect, it } from "vitest";
import { formatCoins, parseCoins } from "./coins";

describe("parseCoins", () => {
  it("converts coin text to base units exactly", () => {
    expect(parseCoins("0")).toEqual({ ok: true, baseUnits: 0n });
    expect(parseCoins("1")).toEqual({ ok: true, baseUnits: 1_000_000n });
    expect(parseCoins(" 2.5 ")).toEqual({ ok: true, baseUnits: 2_500_000n });
    expect(parseCoins("0.000001")).toEqual({ ok: true, baseUnits: 1n });
    expect(parseCoins("0.1")).toEqual({ ok: true, baseUnits: 100_000n });
    expect(parseCoins("18446744073709.551615")).toEqual({ ok: true, baseUnits: (1n << 64n) - 1n });
  });

  it("rejects anything that is not a plain non-negative decimal within u64", () => {
    expect(parseCoins("")).toEqual({ ok: false, error: "empty" });
    expect(parseCoins("0.0000001")).toEqual({ ok: false, error: "too-many-decimals" });
    expect(parseCoins("18446744073709.551616")).toEqual({ ok: false, error: "out-of-range" });
    for (const text of ["-1", "1e3", "1,5", ".5", "5.", "0x10", "1 000", "NaN", "Infinity"]) {
      expect(parseCoins(text), text).toEqual({ ok: false, error: "invalid" });
    }
  });
});

describe("formatCoins", () => {
  it("formats base units with trimmed decimals", () => {
    expect(formatCoins(0n)).toBe("0.00");
    expect(formatCoins(1_500_000n)).toBe("1.50");
    expect(formatCoins(3_280_000n)).toBe("3.28");
    expect(formatCoins(1n)).toBe("0.000001");
    expect(formatCoins(20_480_000n, 0)).toBe("20.48");
    expect(formatCoins(2_000_000n, 0)).toBe("2");
    expect(formatCoins(-1_000_000n)).toBe("-1.00");
  });

  it("round-trips through parseCoins", () => {
    for (const value of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n]) {
      expect(parseCoins(formatCoins(value))).toEqual({ ok: true, baseUnits: value });
    }
  });
});
