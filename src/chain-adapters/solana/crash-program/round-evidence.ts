import type { RoundAccount } from "./accounts";
import { CRASH_PROGRAM_ID } from "./deployment";
import { livePhase } from "./view-mapping";

/** Maps a round account to the chain-agnostic evidence the verifier consumes (spec crash-client-v1 §8). */

function toOutcomeKind(round: RoundAccount): "revealed" | "pending" | "voided" | "forfeited" {
  const phase = livePhase(round.phase);
  if (phase === "crashed" || phase === "settled") return "revealed";
  if (phase === "voided" || phase === "forfeited") return phase;
  return "pending";
}

/** Everything a verifier needs about one round, in chain-agnostic form. */
export function roundEvidence(round: RoundAccount) {
  return {
    programId: CRASH_PROGRAM_ID.toBytes(),
    roundId: round.roundId,
    rulesVersion: round.rulesVersion,
    outcome: toOutcomeKind(round),
    commit: round.commit,
    seed: round.seed,
    vrfOutput: round.vrfOutput,
    crashPoint: round.crashPoint,
    crashTick: round.crashTick,
  };
}

