import { CENTI_STEP, MULTIPLIER_SCALE, type Multiplier } from "../domain/units";

/** Multipliers are typed and shown with two decimals (the recognized precision, spec §2). */

export type MultiplierParseResult = { ok: true; multiplier: Multiplier } | { ok: false; error: "invalid" | "too-many-decimals" };

const MULTIPLIER_TEXT = /^(\d{1,7})(?:\.(\d+))?x?$/i;

export function parseMultiplierText(text: string): MultiplierParseResult {
  const match = MULTIPLIER_TEXT.exec(text.trim());
  if (!match) return { ok: false, error: "invalid" };
  const [, whole, fraction = ""] = match;
  if (fraction.length > 2) return { ok: false, error: "too-many-decimals" };
  return { ok: true, multiplier: BigInt(whole) * MULTIPLIER_SCALE + BigInt(fraction.padEnd(2, "0")) * CENTI_STEP };
}

/** `24_500n → "2.45x"` (truncated to hundredths, never rounded up). */
export function formatMultiplier(multiplier: Multiplier): string {
  const centi = multiplier / CENTI_STEP;
  return `${centi / 100n}.${(centi % 100n).toString().padStart(2, "0")}x`;
}
