import { describe, expect, it } from "vitest";
import { formatMultiplier, parseMultiplierText } from "./multiplier-text";

describe("multiplier text", () => {
  it("parses up to two decimals into ten-thousandths", () => {
    expect(parseMultiplierText("2")).toEqual({ ok: true, multiplier: 20_000n });
    expect(parseMultiplierText("1.01")).toEqual({ ok: true, multiplier: 10_100n });
    expect(parseMultiplierText(" 2.5x ")).toEqual({ ok: true, multiplier: 25_000n });
    expect(parseMultiplierText("1.015")).toEqual({ ok: false, error: "too-many-decimals" });
    for (const text of ["", "-2", "abc", "1e2", ".5", "2,5"]) {
      expect(parseMultiplierText(text), text).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("formats by truncating to hundredths", () => {
    expect(formatMultiplier(10_000n)).toBe("1.00x");
    expect(formatMultiplier(24_599n)).toBe("2.45x");
    expect(formatMultiplier(1_000_000n)).toBe("100.00x");
  });
});
