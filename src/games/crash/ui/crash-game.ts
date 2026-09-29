"use client";

import { createContext, useContext } from "react";
import type { BetLimits } from "../domain/limits";
import type { RoundPhase } from "../domain/round-lifecycle";
import type { Amount, Multiplier } from "../domain/units";
import type { ActionState } from "@/platform/transactions/action-state";

/**
 * Chain-agnostic port for the live Crash game (docs/specs/crash-client-v1.md §5–6). Everything
 * here comes from the settlement authority's confirmed state, except `estimatedTick`, which is an
 * explicitly labeled projection.
 */

export interface LiveRound {
  roundId: bigint;
  rulesVersion: number;
  phase: RoundPhase;
  commitHex: string;
  bettingEndTick: bigint;
  /** Known once the round runs. */
  startTick: bigint | null;
  /** Known only after the reveal. */
  crashPoint: Multiplier | null;
  crashTick: bigint | null;
  betCount: number;
}

export interface MyBet {
  roundId: bigint;
  stake: Amount;
  /** 0 = none. */
  autoCashOut: Multiplier;
  exposure: Amount;
  cashOutTick: bigint | null;
}

export interface RoundSummary {
  roundId: bigint;
  phase: RoundPhase;
  crashPoint: Multiplier | null;
  betCount: number;
}

export interface CrashGamePort {
  connection: "connecting" | "live" | "stale";
  paused: boolean;
  limits: BetLimits | null;
  /** The active round, or the last one when none is active. */
  round: LiveRound | null;
  /** Projection of the settlement clock (tick = slot); call per animation frame. */
  estimatedTick(): bigint | null;
  myBet: MyBet | null;
  /** Why the player cannot bet right now, or null if they can. */
  playerBlocker: string | null;
  balance: Amount | null;
  recentRounds: readonly RoundSummary[];
  action: ActionState;
  /** Public explorer link for a transaction signature. */
  explorerUrl(signature: string): string;
  placeBet(stake: Amount, autoCashOut: Multiplier): Promise<void>;
  cashOut(): Promise<void>;
  settle(): Promise<void>;
}

const CrashGameContext = createContext<CrashGamePort | null>(null);

export const CrashGameProvider = CrashGameContext.Provider;

export function useCrashGame(): CrashGamePort {
  const port = useContext(CrashGameContext);
  if (!port) throw new Error("useCrashGame requires a CrashGameProvider");
  return port;
}
