"use client";

import { createContext, useContext } from "react";
import type { BetLimits } from "../domain/limits";
import type { RoundPhase } from "../domain/round-lifecycle";
import type { Amount, Multiplier } from "../domain/units";
import type { ActionState } from "@/platform/transactions/action-state";

/**
 * Chain-agnostic port for the live Crash game (docs/specs/crash-client-v1.md §5–6). Everything
 * here comes from the settlement authority's confirmed state, except the clock projections
 * (`projectedTick`, `estimatedTick`, `msPerTick`) and `revealHint`, an untrusted hint the UI
 * verifies against `commitHex` before showing anything (ADR 0004).
 */

export interface LiveRound {
  roundId: bigint;
  rulesVersion: number;
  phase: RoundPhase;
  commitHex: string;
  openedTick: bigint;
  bettingEndTick: bigint;
  /** Known once the round runs. */
  startTick: bigint | null;
  /** Randomness output recorded when the round started (hex), for verifying a revealed seed. */
  vrfOutputHex: string | null;
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
  /**
   * Continuous, monotonic projection of the settlement clock (tick = slot), fractional; call per
   * animation frame. Presentation only (curve and headline).
   */
  projectedTick(): number | null;
  /** `floor(projectedTick())`: whole ticks, used for anything offered or computed from the rules. */
  estimatedTick(): bigint | null;
  /** Measured duration of a tick in ms, for countdowns and axes. */
  msPerTick(): number;
  /** Seed announced by the operator's live feed for a round, unverified. */
  revealHint: { roundId: bigint; seedHex: string } | null;
  liveFeed: "off" | "connecting" | "live" | "down";
  /** Settlement program id (hex), the domain separator of the fairness scheme. */
  programIdHex: string;
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
