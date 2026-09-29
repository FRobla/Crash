import type { HouseConfigAccount, RoundAccount } from "@/chain-adapters/solana/crash-program/accounts";

/**
 * The crank as a pure state machine (docs/specs/crash-client-v1.md §4.2–4.3): given what the
 * chain says and whether the operator holds the round's seed, decide the single next action.
 * Every branch also covers a restart at that point, because the plan never relies on memory
 * of earlier steps.
 */

export type CrankAction =
  | { kind: "open"; roundId: bigint }
  | { kind: "close-betting"; roundId: bigint }
  | { kind: "start"; roundId: bigint }
  | { kind: "reveal"; roundId: bigint }
  | { kind: "void"; roundId: bigint; reason: "missing-seed" | "commit-timeout" | "entropy-timeout" }
  | { kind: "forfeit"; roundId: bigint }
  | { kind: "wait"; untilSlot: bigint | null; reason: string };

export interface CrankState {
  config: HouseConfigAccount;
  /** The account of `config.currentRound`, when there is one. */
  round: RoundAccount | null;
  slot: bigint;
  /** Whether the operator holds a seed matching `round.commit`. */
  hasSeed: boolean;
  /** Crash tick recomputed by the operator from its seed; required in `Running` when `hasSeed`. */
  crashTick: bigint | null;
}

export function planNextAction({ config, round, slot, hasSeed, crashTick }: CrankState): CrankAction {
  if (config.currentRound === null) {
    if (config.paused) return { kind: "wait", untilSlot: null, reason: "house paused" };
    return { kind: "open", roundId: config.nextRoundId };
  }
  if (!round || round.roundId !== config.currentRound) {
    return { kind: "wait", untilSlot: null, reason: "current round not loaded" };
  }
  const roundId = round.roundId;

  switch (round.phase) {
    case "Betting": {
      if (!hasSeed) return { kind: "void", roundId, reason: "missing-seed" };
      if (slot < round.bettingEndSlot) return { kind: "wait", untilSlot: round.bettingEndSlot, reason: "betting open" };
      if (slot > round.bettingEndSlot + config.timeouts.entropyTimeoutSlots) {
        return { kind: "void", roundId, reason: "commit-timeout" };
      }
      return { kind: "close-betting", roundId };
    }
    case "AwaitingEntropy": {
      if (slot > round.entropyDeadlineSlot) return { kind: "void", roundId, reason: "entropy-timeout" };
      // Without the seed the round could never be revealed: leave it unstarted so it voids at the
      // deadline instead of forfeiting (anyone may still start it; spec §4.3).
      if (!hasSeed) return { kind: "wait", untilSlot: round.entropyDeadlineSlot + 1n, reason: "no seed: waiting to void" };
      return { kind: "start", roundId };
    }
    case "Running": {
      if (slot > round.revealDeadlineSlot) return { kind: "forfeit", roundId };
      if (!hasSeed || crashTick === null) {
        return { kind: "wait", untilSlot: round.revealDeadlineSlot + 1n, reason: "no seed: waiting to forfeit" };
      }
      const revealSlot = round.startSlot + crashTick;
      if (slot < revealSlot) return { kind: "wait", untilSlot: revealSlot, reason: "running" };
      return { kind: "reveal", roundId };
    }
    default:
      // Reveal, void and forfeit clear `current_round` atomically, so a terminal current round is
      // unexpected; wait for the next snapshot rather than act on it.
      return { kind: "wait", untilSlot: null, reason: `unexpected phase ${round.phase}` };
  }
}
