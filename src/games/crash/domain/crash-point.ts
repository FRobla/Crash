import { assertValidMaxMultiplier, CENTI_STEP, MULTIPLIER_SCALE, type Multiplier } from "./units";

/**
 * Crash point derivation from opaque entropy (spec §5). Where the entropy comes from and how it is
 * verified is decided by ADR 0002; this function never generates randomness.
 */

export const ENTROPY_BYTES = 32;
export const UNIFORM_BITS = 52n;
export const UNIFORM_RANGE = 1n << UNIFORM_BITS;

export interface CrashPointParams {
  houseEdgeBps: bigint;
  maxMultiplier: Multiplier;
}

export function assertValidCrashPointParams({ houseEdgeBps, maxMultiplier }: CrashPointParams): void {
  if (houseEdgeBps < 0n || houseEdgeBps >= MULTIPLIER_SCALE) {
    throw new RangeError("houseEdgeBps must be within [0, 10000)");
  }
  assertValidMaxMultiplier(maxMultiplier);
}

/** The first 52 bits of the entropy, big-endian: uniform in `[0, 2⁵²)`. */
export function uniformFromEntropy(entropy: Uint8Array): bigint {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new RangeError(`entropy must be exactly ${ENTROPY_BYTES} bytes`);
  }
  let value = 0n;
  for (let index = 0; index < 7; index += 1) {
    value = (value << 8n) | BigInt(entropy[index]);
  }
  return value >> 4n;
}

export function crashPointFromUniform(uniform: bigint, params: CrashPointParams): Multiplier {
  assertValidCrashPointParams(params);
  if (uniform < 0n || uniform >= UNIFORM_RANGE) {
    throw new RangeError("uniform must be within [0, 2^52)");
  }
  const rawCenti =
    ((MULTIPLIER_SCALE - params.houseEdgeBps) * UNIFORM_RANGE) /
    (CENTI_STEP * (UNIFORM_RANGE - uniform));
  const centi = rawCenti < CENTI_STEP ? CENTI_STEP : rawCenti;
  const crashPoint = centi * CENTI_STEP;
  return crashPoint < params.maxMultiplier ? crashPoint : params.maxMultiplier;
}

export function crashPointFromEntropy(entropy: Uint8Array, params: CrashPointParams): Multiplier {
  return crashPointFromUniform(uniformFromEntropy(entropy), params);
}
