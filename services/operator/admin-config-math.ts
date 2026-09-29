import type { HouseConfigAccount } from "@/chain-adapters/solana/crash-program/accounts";
import type { UpdateConfigArgs } from "@/chain-adapters/solana/crash-program/instructions";
import { clampMsPerSlot } from "@/chain-adapters/solana/network/slot-clock";

/** Pure parts of the admin tool (admin-config.ts), kept apart so they are testable. */

export const MIN_BETTING_SECONDS = 3;
export const MAX_BETTING_SECONDS = 120;

/** Reads `--betting-seconds <n>` (pnpm may forward a leading `--`). */
export function parseBettingSeconds(argv: readonly string[]): number {
  const args = argv.filter((arg) => arg !== "--");
  const index = args.indexOf("--betting-seconds");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || !/^\d+$/.test(value)) throw new Error("usage: --betting-seconds <whole seconds>");
  const seconds = Number(value);
  if (seconds < MIN_BETTING_SECONDS || seconds > MAX_BETTING_SECONDS) {
    throw new Error(`--betting-seconds must be between ${MIN_BETTING_SECONDS} and ${MAX_BETTING_SECONDS}`);
  }
  return seconds;
}

/** Whole slots covering at least `seconds` at the measured (clamped) slot duration. */
export function bettingSlotsFor(seconds: number, msPerSlot: number): bigint {
  return BigInt(Math.ceil((seconds * 1000) / clampMsPerSlot(msPerSlot)));
}

/** `update_config` arguments that change only `betting_slots`. */
export function updatedConfigArgs(config: HouseConfigAccount, bettingSlots: bigint): UpdateConfigArgs {
  if (bettingSlots <= 0n) throw new Error("betting slots must be positive");
  return {
    operator: config.operator,
    limits: { ...config.limits },
    timeouts: { ...config.timeouts, bettingSlots },
    maxBetsPerRound: config.maxBetsPerRound,
    paused: config.paused,
    playerPolicy: { ...config.playerPolicy },
  };
}
