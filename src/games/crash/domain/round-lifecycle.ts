import type { Bet } from "./bet";
import {
  validateBet,
  validateRoundExposure,
  type BetLimits,
  type BetRejection,
  type RoundExposureRejection,
} from "./limits";
import { err, ok, type Result } from "./result";
import type { Amount, Multiplier } from "./units";

/** Round lifecycle (spec §3). Invalid transitions return typed errors; nothing here throws. */

export type RoundPhase =
  | "betting"
  | "awaiting-entropy"
  | "running"
  | "crashed"
  | "settled"
  | "voided"
  | "forfeited";

export type RoundTransition = "close-betting" | "start" | "crash" | "settle" | "void" | "forfeit";

const TRANSITIONS: Record<RoundTransition, { from: readonly RoundPhase[]; to: RoundPhase }> = {
  "close-betting": { from: ["betting"], to: "awaiting-entropy" },
  start: { from: ["awaiting-entropy"], to: "running" },
  crash: { from: ["running"], to: "crashed" },
  settle: { from: ["crashed"], to: "settled" },
  // Only before running: nobody knows the outcome yet, so cancelling cannot favor anyone.
  void: { from: ["betting", "awaiting-entropy"], to: "voided" },
  forfeit: { from: ["running"], to: "forfeited" },
};

export interface InvalidTransition {
  code: "invalid-transition";
  from: RoundPhase;
  transition: RoundTransition;
}

export interface RoundState {
  phase: RoundPhase;
  bets: readonly Bet[];
  /** Sum of the accepted bets' exposures. */
  exposure: Amount;
}

export type PlaceBetRejection = BetRejection | RoundExposureRejection | "betting-closed" | "duplicate-bet";

export function createRound(): RoundState {
  return { phase: "betting", bets: [], exposure: 0n };
}

export function transitionPhase(
  phase: RoundPhase,
  transition: RoundTransition,
): Result<RoundPhase, InvalidTransition> {
  const rule = TRANSITIONS[transition];
  return rule.from.includes(phase)
    ? ok(rule.to)
    : err({ code: "invalid-transition", from: phase, transition });
}

export function applyTransition(
  round: RoundState,
  transition: RoundTransition,
): Result<RoundState, InvalidTransition> {
  const next = transitionPhase(round.phase, transition);
  return next.ok ? ok({ ...round, phase: next.value }) : next;
}

export function placeBet(
  round: RoundState,
  bet: Bet,
  limits: BetLimits,
  maxMultiplier: Multiplier,
): Result<RoundState, PlaceBetRejection> {
  if (round.phase !== "betting") return err("betting-closed");
  if (round.bets.some((existing) => existing.id === bet.id)) return err("duplicate-bet");

  const exposure = validateBet(bet, limits, maxMultiplier);
  if (!exposure.ok) return exposure;

  const total = validateRoundExposure(round.exposure, exposure.value, limits);
  if (!total.ok) return total;

  return ok({ ...round, bets: [...round.bets, bet], exposure: total.value });
}
