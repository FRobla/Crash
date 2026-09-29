import type { BetRejection } from "../domain/limits";
import { validateBet } from "../domain/limits";
import { createMultiplierCurve, recognizedMultiplierAtTick, type MultiplierCurve } from "../domain/multiplier-curve";
import type { RoundPhase } from "../domain/round-lifecycle";
import { rulesForVersion, type CrashRules } from "../domain/rules";
import { refundRound, settleForfeitedRound, settleRound } from "../domain/settle-round";
import { ONE_X, payoutFor, type Amount, type Multiplier } from "../domain/units";
import type { CrashGamePort, LiveRound, MyBet } from "./crash-game";

/**
 * Pure view logic for the live round (spec crash-client-v1 §5–6). It decides what the UI may
 * offer; the program still decides what is accepted.
 */

/** Nominal slot duration, only to turn slot counts into approximate seconds. */
export const APPROX_SECONDS_PER_TICK = 0.4;

const curves = new Map<number, MultiplierCurve>();

export function curveForRules(rules: CrashRules): MultiplierCurve {
  let curve = curves.get(rules.version);
  if (!curve) {
    curve = createMultiplierCurve(rules.growthPpm, rules.maxMultiplier);
    curves.set(rules.version, curve);
  }
  return curve;
}

/** Recognized multiplier at a round-relative tick, clamped to the curve horizon. */
export function multiplierAt(rules: CrashRules, tick: bigint): Multiplier {
  const curve = curveForRules(rules);
  const index = tick < 0n ? 0 : tick >= BigInt(curve.points.length) ? curve.points.length - 1 : Number(tick);
  return recognizedMultiplierAtTick(curve, index);
}

export type RoundDisplay =
  | { kind: "idle" }
  | { kind: "betting"; secondsLeft: number }
  | { kind: "awaiting-entropy" }
  /** The multiplier is a projection until the reveal. */
  | { kind: "running"; multiplier: Multiplier }
  | { kind: "crashed"; crashPoint: Multiplier }
  | { kind: "voided" }
  | { kind: "forfeited" };

export function roundDisplay(round: LiveRound | null, tick: bigint | null): RoundDisplay {
  if (!round) return { kind: "idle" };
  const rules = rulesForVersion(round.rulesVersion);
  switch (round.phase) {
    case "betting": {
      const left = tick === null ? 0n : round.bettingEndTick - tick;
      return { kind: "betting", secondsLeft: Math.max(0, Math.ceil(Number(left) * APPROX_SECONDS_PER_TICK)) };
    }
    case "awaiting-entropy":
      return { kind: "awaiting-entropy" };
    case "running": {
      if (!rules || round.startTick === null || tick === null) return { kind: "running", multiplier: ONE_X };
      return { kind: "running", multiplier: multiplierAt(rules, tick - round.startTick) };
    }
    case "crashed":
    case "settled":
      return round.crashPoint === null ? { kind: "idle" } : { kind: "crashed", crashPoint: round.crashPoint };
    case "voided":
      return { kind: "voided" };
    case "forfeited":
      return { kind: "forfeited" };
  }
}

const TERMINAL: readonly RoundPhase[] = ["crashed", "settled", "voided", "forfeited"];

/** A bet from an earlier round that can (and must) be settled before betting again. */
export function betAwaitingSettlement(myBet: MyBet | null, round: LiveRound | null): boolean {
  if (!myBet || !round) return false;
  return myBet.roundId !== round.roundId || TERMINAL.includes(round.phase);
}

const REJECTION_TEXT: Record<BetRejection, string> = {
  "stake-below-minimum": "Stake is below the minimum.",
  "stake-above-maximum": "Stake is above the maximum.",
  "auto-cash-out-not-centi-precise": "Auto cash-out allows two decimals.",
  "auto-cash-out-below-minimum": "Auto cash-out must be at least 1.01x.",
  "auto-cash-out-above-maximum": "Auto cash-out is above the maximum multiplier.",
  "payout-above-maximum": "Potential payout exceeds the house limit; lower the stake or set an auto cash-out.",
};

export type BetCheck = { ok: true; exposure: Amount } | { ok: false; reason: string };

/** Client-side pre-check of a new bet (the program re-checks everything). */
export function checkNewBet(
  game: Pick<CrashGamePort, "round" | "limits" | "paused" | "playerBlocker" | "balance" | "myBet">,
  tick: bigint | null,
  stake: Amount,
  autoCashOut: Multiplier | null,
): BetCheck {
  const { round, limits } = game;
  if (game.paused) return { ok: false, reason: "The house is paused." };
  if (game.playerBlocker) return { ok: false, reason: game.playerBlocker };
  if (!round || round.phase !== "betting") return { ok: false, reason: "Wait for the next round to open." };
  if (tick !== null && tick >= round.bettingEndTick) return { ok: false, reason: "Betting is closing." };
  if (game.myBet && game.myBet.roundId === round.roundId) return { ok: false, reason: "You already bet in this round." };
  const rules = rulesForVersion(round.rulesVersion);
  if (!limits || !rules) return { ok: false, reason: "House limits not loaded." };
  if (game.balance !== null && stake > game.balance) return { ok: false, reason: "Not enough coins." };
  const result = validateBet({ stake, autoCashOut }, limits, rules.maxMultiplier);
  return result.ok ? { ok: true, exposure: result.value } : { ok: false, reason: REJECTION_TEXT[result.error] };
}

/** The live cash-out offer for the player's bet in the running round, if any. */
export function cashOutOffer(round: LiveRound | null, myBet: MyBet | null, tick: bigint | null) {
  if (!round || round.phase !== "running" || !myBet || myBet.roundId !== round.roundId) return null;
  if (myBet.cashOutTick !== null || round.startTick === null || tick === null) return null;
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules) return null;
  const multiplier = multiplierAt(rules, tick - round.startTick);
  return { multiplier, payout: payoutFor(myBet.stake, multiplier) };
}

/** Recognized multiplier of a recorded cash-out tick. */
export function cashedOutAt(round: LiveRound | null, myBet: MyBet | null): Multiplier | null {
  if (!round || !myBet || myBet.cashOutTick === null) return null;
  const rules = rulesForVersion(round.rulesVersion);
  return rules ? multiplierAt(rules, myBet.cashOutTick) : null;
}

export type MyBetOutcome =
  | { kind: "open" }
  | { kind: "cashed-out"; multiplier: Multiplier; payout: Amount }
  | { kind: "lost" }
  | { kind: "refunded"; payout: Amount };

/**
 * Outcome of the player's bet as the rules decide it, computed with the domain engine from the
 * round's public result. The balance still only changes when the settlement lands on-chain.
 */
export function myBetOutcome(round: LiveRound | null, myBet: MyBet | null): MyBetOutcome {
  if (!round || !myBet || myBet.roundId !== round.roundId) return { kind: "open" };
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules) return { kind: "open" };
  const curve = curveForRules(rules);
  const bet = { id: "mine", stake: myBet.stake, autoCashOut: myBet.autoCashOut === 0n ? null : myBet.autoCashOut };
  const cashOuts = myBet.cashOutTick === null ? [] : [{ betId: "mine", tick: Number(myBet.cashOutTick) }];
  let settlement;
  if (round.phase === "voided") settlement = refundRound([bet]).settlements[0];
  else if (round.phase === "forfeited") settlement = settleForfeitedRound([bet], cashOuts, curve).settlements[0];
  else if ((round.phase === "crashed" || round.phase === "settled") && round.crashPoint !== null) {
    settlement = settleRound([bet], cashOuts, round.crashPoint, curve).settlements[0];
  } else return { kind: "open" };
  if (settlement.outcome === "cashed-out") {
    return { kind: "cashed-out", multiplier: settlement.multiplier, payout: settlement.payout };
  }
  return settlement.outcome === "lost" ? { kind: "lost" } : { kind: "refunded", payout: settlement.payout };
}
