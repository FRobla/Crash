/**
 * JSON-lines logger for the crank. Callers pass only public data (round ids, signatures, public
 * keys, error names); unrevealed seeds and key material must never reach it.
 */

type Level = "info" | "warn" | "error";

export type Logger = Record<Level, (event: string, fields: Record<string, unknown>) => void>;

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: Level) => (event: string, fields: Record<string, unknown>) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
