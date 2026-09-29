import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { BorshReader, decodeDefined, type Decoded } from "./borsh";
import { CRASH_IDL, CRASH_IDL_TYPES, idlTypeDef } from "./idl";

/**
 * Anchor `emit!` events, read from `Program data:` log lines. Only lines emitted while the crash
 * program is the innermost running program are accepted, so a CPI callee cannot forge events.
 */

export type BetOutcome = "CashedOut" | "Lost" | "Refunded";

export interface BetSettledEvent {
  roundId: bigint;
  player: PublicKey;
  stake: bigint;
  autoCashOut: bigint;
  cashOutTick: bigint | null;
  outcome: BetOutcome;
  multiplier: bigint;
  payout: bigint;
  balance: bigint;
  totalWagered: bigint;
}

export interface DecodedEvent {
  name: string;
  data: Decoded;
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA_PREFIX = "Program data: ";

export function decodeEvents(logs: readonly string[], programId: PublicKey): DecodedEvent[] {
  const program = programId.toBase58();
  const stack: string[] = [];
  const events: DecodedEvent[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX) || stack[stack.length - 1] !== program) continue;
    const event = decodeEventData(Uint8Array.from(Buffer.from(line.slice(DATA_PREFIX.length), "base64")));
    if (event) events.push(event);
  }
  return events;
}

export function decodeEventData(bytes: Uint8Array): DecodedEvent | null {
  const spec = CRASH_IDL.events.find((event) => event.discriminator.every((byte, i) => bytes[i] === byte));
  if (!spec || bytes.length < 8) return null;
  const data = decodeDefined(new BorshReader(bytes.subarray(8)), idlTypeDef(spec.name), CRASH_IDL_TYPES);
  return { name: spec.name, data };
}

export function betSettledEvents(logs: readonly string[], programId: PublicKey): BetSettledEvent[] {
  return decodeEvents(logs, programId)
    .filter((event) => event.name === "BetSettled")
    .map((event) => event.data as unknown as BetSettledEvent);
}
