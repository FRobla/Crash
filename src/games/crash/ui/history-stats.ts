import type { RoundPhase } from "../domain/round-lifecycle";
import type { Amount, Multiplier } from "../domain/units";

/**
 * Summaries of already-settled, public data for display. They describe the rows they are given
 * (a recent window from the RPC), never the full history, and move no money.
 */

export interface CrashPointStats {
  /** Rounds with a revealed crash point. */
  revealed: number;
  atLeastTwo: number;
  median: Multiplier | null;
  highest: Multiplier | null;
}

const TWO_X: Multiplier = 20_000n;

function isRevealed(phase: RoundPhase): boolean {
  return phase === "crashed" || phase === "settled";
}

export function crashPointStats(rounds: readonly { phase: RoundPhase; crashPoint: Multiplier | null }[]): CrashPointStats {
  const points = rounds
    .flatMap((round) => (isRevealed(round.phase) && round.crashPoint !== null ? [round.crashPoint] : []))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (points.length === 0) return { revealed: 0, atLeastTwo: 0, median: null, highest: null };
  const middle = Math.floor(points.length / 2);
  // Lower median, so the value shown is always one that actually happened.
  const median = points.length % 2 === 1 ? points[middle] : points[middle - 1];
  return {
    revealed: points.length,
    atLeastTwo: points.filter((point) => point >= TWO_X).length,
    median,
    highest: points[points.length - 1],
  };
}

export interface BetSummary {
  count: number;
  won: number;
  lost: number;
  refunded: number;
  staked: Amount;
  paidOut: Amount;
  /** paidOut − staked; negative when the player is down over these rows. */
  net: bigint;
}

export function summarizeBets(rows: readonly { stake: Amount; payout: Amount; outcome: "cashed-out" | "lost" | "refunded" }[]): BetSummary {
  const summary: BetSummary = { count: 0, won: 0, lost: 0, refunded: 0, staked: 0n, paidOut: 0n, net: 0n };
  for (const row of rows) {
    summary.count += 1;
    summary.staked += row.stake;
    summary.paidOut += row.payout;
    if (row.outcome === "cashed-out") summary.won += 1;
    else if (row.outcome === "lost") summary.lost += 1;
    else summary.refunded += 1;
  }
  summary.net = summary.paidOut - summary.staked;
  return summary;
}
