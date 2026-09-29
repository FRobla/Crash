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
 * offer; the program still decides what is accepted. Durations use the measured tick length the
 * port reports, never a nominal one.
 */

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

/** A round as the UI shows it: `provisional` marks a crash verified from the live feed's seed. */
export type ShownRound = LiveRound & { provisional?: boolean };

export type RoundDisplay =
  | { kind: "idle" }
  | { kind: "betting"; msLeft: number; secondsLeft: number }
  /** Betting closed; waiting for verifiable randomness before take-off. */
  | { kind: "launching" }
  /** The multiplier is a projection until the reveal. */
  | { kind: "running"; multiplier: Multiplier }
  /** `provisional`: verified against the on-chain commit, on-chain reveal still pending. */
  | { kind: "crashed"; crashPoint: Multiplier; provisional: boolean }
  | { kind: "voided" }
  | { kind: "forfeited" };

/** Time left to bet at the measured tick length, from a (possibly fractional) projected tick. */
export function bettingMsLeft(round: Pick<LiveRound, "bettingEndTick">, tick: number | null, msPerTick: number): number {
  if (tick === null) return 0;
  return Math.max(0, (Number(round.bettingEndTick) - tick) * msPerTick);
}

/** Length of the round's betting window in ms, at the measured tick length. */
export function bettingWindowMs(round: Pick<LiveRound, "openedTick" | "bettingEndTick">, msPerTick: number): number {
  return Math.max(0, Number(round.bettingEndTick - round.openedTick) * msPerTick);
}

export function roundDisplay(round: ShownRound | null, tick: number | null, msPerTick: number): RoundDisplay {
  if (!round) return { kind: "idle" };
  const rules = rulesForVersion(round.rulesVersion);
  switch (round.phase) {
    case "betting": {
      const msLeft = bettingMsLeft(round, tick, msPerTick);
      return { kind: "betting", msLeft, secondsLeft: Math.ceil(msLeft / 1000) };
    }
    case "awaiting-entropy":
      return { kind: "launching" };
    case "running": {
      if (!rules || round.startTick === null || tick === null) return { kind: "running", multiplier: ONE_X };
      const multiplier = multiplierAt(rules, BigInt(Math.floor(tick)) - round.startTick);
      // A crash played out as running (presentation-lag.ts) is never shown past its crash point.
      return { kind: "running", multiplier: round.crashPoint !== null && round.crashPoint < multiplier ? round.crashPoint : multiplier };
    }
    case "crashed":
    case "settled":
      return round.crashPoint === null
        ? { kind: "idle" }
        : { kind: "crashed", crashPoint: round.crashPoint, provisional: round.provisional === true };
    case "voided":
      return { kind: "voided" };
    case "forfeited":
      return { kind: "forfeited" };
  }
}

export interface EarlyCrash {
  roundId: bigint;
  crashPoint: Multiplier;
  crashTick: bigint;
}

/**
 * Applies a verified crash from the live feed to a running round, as a provisional result.
 * Only a running round changes: once the account is revealed (or voided/forfeited) it wins.
 */
export function applyEarlyCrash(round: LiveRound | null, early: EarlyCrash | null): ShownRound | null {
  if (!round || !early || early.roundId !== round.roundId || round.phase !== "running") return round;
  return { ...round, phase: "crashed", crashPoint: early.crashPoint, crashTick: early.crashTick, provisional: true };
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

/**
 * The live cash-out offer for the player's bet in the running round, if any. None once the
 * projected multiplier reaches the bet's auto cash-out: from then on the auto cash-out wins any
 * tie or later manual one (crash-round-rules.md §6), so the button could not pay what it shows.
 */
export function cashOutOffer(round: LiveRound | null, myBet: MyBet | null, tick: bigint | null) {
  if (!round || round.phase !== "running" || !myBet || myBet.roundId !== round.roundId) return null;
  if (myBet.cashOutTick !== null || round.startTick === null || tick === null) return null;
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules) return null;
  const multiplier = multiplierAt(rules, tick - round.startTick);
  if (autoTargetReached(myBet, multiplier)) return null;
  return { multiplier, payout: payoutFor(myBet.stake, multiplier) };
}

/** Whether a projected multiplier has reached the bet's auto cash-out (projection, not a result). */
export function autoTargetReached(myBet: MyBet, multiplier: Multiplier): boolean {
  return myBet.autoCashOut !== 0n && multiplier >= myBet.autoCashOut;
}

/** The projected running multiplier for the player's open bet, if the round is running. */
export function projectedMultiplier(round: LiveRound | null, tick: bigint | null): Multiplier | null {
  if (!round || round.phase !== "running" || round.startTick === null || tick === null) return null;
  const rules = rulesForVersion(round.rulesVersion);
  return rules ? multiplierAt(rules, tick - round.startTick) : null;
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
