/**
 * Coins are presentation only (ADR 0003): 1 coin = 10⁶ base units (lamports for SOL), so the base
 * unit of a coin is exactly one lamport. Conversions work on the text with integers, never floats.
 */

export const COIN_DECIMALS = 6;
export const BASE_UNITS_PER_COIN = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;

export type CoinParseError = "empty" | "invalid" | "too-many-decimals" | "out-of-range";

export type CoinParseResult = { ok: true; baseUnits: bigint } | { ok: false; error: CoinParseError };

const COIN_TEXT = /^(\d+)(?:\.(\d+))?$/;

export function parseCoins(text: string): CoinParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "empty" };
  const match = COIN_TEXT.exec(trimmed);
  if (!match) return { ok: false, error: "invalid" };
  const [, whole, fraction = ""] = match;
  if (fraction.length > COIN_DECIMALS) return { ok: false, error: "too-many-decimals" };
  const baseUnits = BigInt(whole) * BASE_UNITS_PER_COIN + BigInt(fraction.padEnd(COIN_DECIMALS, "0"));
  if (baseUnits > U64_MAX) return { ok: false, error: "out-of-range" };
  return { ok: true, baseUnits };
}

/** `1_500_000n → "1.50"`: trailing zeros trimmed, keeping at least `minDecimals`. */
export function formatCoins(baseUnits: bigint, minDecimals = 2): string {
  const negative = baseUnits < 0n;
  const absolute = negative ? -baseUnits : baseUnits;
  const whole = absolute / BASE_UNITS_PER_COIN;
  let fraction = (absolute % BASE_UNITS_PER_COIN).toString().padStart(COIN_DECIMALS, "0");
  while (fraction.length > minDecimals && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
