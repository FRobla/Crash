import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  crashPointFromEntropy,
  crashPointFromUniform,
  ENTROPY_BYTES,
  UNIFORM_RANGE,
  uniformFromEntropy,
  type CrashPointParams,
} from "./crash-point";

const params: CrashPointParams = { houseEdgeBps: 300n, maxMultiplier: 1_000_000n };
const E = UNIFORM_RANGE;
const A = (10_000n - params.houseEdgeBps) * E;

/** Number of uniforms `r` whose crash point is `>= centi` hundredths (spec §8). */
function winningUniforms(centi: bigint): bigint {
  return A / (100n * centi);
}

describe("uniformFromEntropy", () => {
  it("reads the first 52 bits big-endian and ignores the rest", () => {
    const entropy = new Uint8Array(ENTROPY_BYTES).fill(0xff);
    expect(uniformFromEntropy(entropy)).toBe(E - 1n);

    const sample = new Uint8Array(ENTROPY_BYTES);
    sample.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xff]);
    expect(uniformFromEntropy(sample)).toBe(0x123456789abcdn);
  });

  it.each([0, 31, 33, 64])("rejects %s bytes of entropy", (length) => {
    expect(() => uniformFromEntropy(new Uint8Array(length))).toThrow(RangeError);
  });
});

describe("crashPointFromUniform", () => {
  it("maps the extremes without overflow", () => {
    expect(crashPointFromUniform(0n, params)).toBe(10_000n);
    expect(crashPointFromUniform(E - 1n, params)).toBe(params.maxMultiplier);
    expect(crashPointFromEntropy(new Uint8Array(ENTROPY_BYTES), params)).toBe(10_000n);
  });

  it("returns centi-precise multipliers within [1.00x, maxMultiplier]", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: E - 1n }), (uniform) => {
        const crashPoint = crashPointFromUniform(uniform, params);
        return crashPoint % 100n === 0n && crashPoint >= 10_000n && crashPoint <= params.maxMultiplier;
      }),
    );
  });

  it("is non-decreasing in the uniform", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: E - 2n }), (uniform) => {
        return crashPointFromUniform(uniform + 1n, params) >= crashPointFromUniform(uniform, params);
      }),
    );
  });

  it("crosses every target exactly at the analytical threshold", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 101n, max: 10_000n }), (centi) => {
        const threshold = E - winningUniforms(centi);
        return (
          crashPointFromUniform(threshold, params) >= centi * 100n &&
          crashPointFromUniform(threshold - 1n, params) < centi * 100n
        );
      }),
    );
  });

  it.each([101n, 150n, 200n, 1_000n, 5_000n, 10_000n])(
    "returns exactly 1 - edge to a fixed %s-hundredths target, within m·2^-52",
    (centi) => {
      // RTP = centi/100 · winning/E; compare with (1 - edge) scaled by 100 · E · 10_000.
      const rtpScaled = centi * winningUniforms(centi) * 10_000n;
      const expectedScaled = (10_000n - params.houseEdgeBps) * E * 100n;
      const shortfall = expectedScaled - rtpScaled;
      expect(shortfall).toBeGreaterThanOrEqual(0n);
      expect(shortfall).toBeLessThan(centi * 10_000n);
    },
  );

  it("crashes below 1.01x with probability 1 - (1 - edge)/1.01", () => {
    const probability = Number(E - winningUniforms(101n)) / Number(E);
    expect(probability).toBeCloseTo(1 - 0.97 / 1.01, 12);
    // Of which exactly `edge` corresponds to rounds clamped up to 1.00x.
    const clamped = E - winningUniforms(100n);
    expect(Number(clamped) / Number(E)).toBeCloseTo(0.03, 12);
  });

  it.each([
    { houseEdgeBps: -1n, maxMultiplier: 1_000_000n },
    { houseEdgeBps: 10_000n, maxMultiplier: 1_000_000n },
    { houseEdgeBps: 300n, maxMultiplier: 10_000n },
  ])("rejects invalid params %o", (invalid) => {
    expect(() => crashPointFromUniform(0n, invalid)).toThrow(RangeError);
  });

  it.each([-1n, E])("rejects uniform %s outside [0, 2^52)", (uniform) => {
    expect(() => crashPointFromUniform(uniform, params)).toThrow(RangeError);
  });
});
