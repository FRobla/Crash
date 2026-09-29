import { CRASH_IDL } from "./idl";

/** Anchor framework errors that the program's account constraints can raise. */
const ANCHOR_ERRORS: Record<number, string> = {
  2000: "ConstraintMut",
  2001: "ConstraintHasOne",
  2002: "ConstraintSigner",
  2003: "ConstraintRaw",
  2006: "ConstraintSeeds",
  2012: "ConstraintAddress",
  3001: "AccountDiscriminatorNotFound",
  3002: "AccountDiscriminatorMismatch",
  3007: "AccountOwnedByWrongProgram",
  3012: "AccountNotInitialized",
};

export function programErrorName(code: number): string {
  return CRASH_IDL.errors.find((error) => error.code === code)?.name ?? ANCHOR_ERRORS[code] ?? `code ${code}`;
}

const CUSTOM_ERROR = /custom program error: 0x([0-9a-f]+)/i;
const ANCHOR_LOG = /Error Code: (\w+)\. Error Number: (\d+)/;

/**
 * Best-effort name of the program error behind a failed send or simulation. Returns `null` when
 * the failure did not come from a program (network, blockhash, wallet rejection).
 */
export function describeProgramError(error: unknown, logs?: readonly string[] | null): string | null {
  for (const line of logs ?? []) {
    const match = ANCHOR_LOG.exec(line);
    if (match) return match[1];
  }
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  const custom = CUSTOM_ERROR.exec(text ?? "");
  if (custom) return programErrorName(Number.parseInt(custom[1], 16));
  const nested = /"Custom":(\d+)/.exec(text ?? "");
  if (nested) return programErrorName(Number(nested[1]));
  return null;
}
