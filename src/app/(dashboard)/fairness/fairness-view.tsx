"use client";

import { CRASH_PROGRAM_ID } from "@/chain-adapters/solana/crash-program/deployment";
import { useRoundEvidence } from "@/chain-adapters/solana/crash-program/use-round-data";
import { useCrashGame } from "@/games/crash/ui/crash-game";
import { FairnessReport } from "@/games/crash/ui/FairnessReport";
import { Panel } from "@/platform/shell/Panel";

const U64_MAX = (1n << 64n) - 1n;

export function FairnessView({ requestedRound }: { requestedRound: string | null }) {
  const game = useCrashGame();
  const requested = requestedRound !== null && BigInt(requestedRound) <= U64_MAX ? BigInt(requestedRound) : null;
  const roundId = requested ?? game.recentRounds[0]?.roundId ?? null;
  const loaded = useRoundEvidence(roundId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Fairness</h1>
      <Panel titleId="fairness-title" title={roundId === null ? "Verify a round" : `Verify round #${roundId}`}>
        <form action="/fairness" className="flex flex-wrap items-end gap-2 border-b border-border p-4">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Round id
            <input
              name="round"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={roundId?.toString() ?? ""}
              className="w-40 border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg"
            />
          </label>
          <button type="submit" className="border border-border px-3 py-2 text-xs uppercase tracking-widest text-muted hover:text-fg">
            Verify
          </button>
        </form>
        {roundId === null && <p className="p-4 text-sm text-muted">Enter a round id, or wait for the first round to finish.</p>}
        {roundId !== null && loaded.status === "loading" && <p className="p-4 text-sm text-muted">Loading round…</p>}
        {roundId !== null && loaded.status === "error" && (
          <p className="p-4 text-sm text-danger">Could not load the round from the RPC.</p>
        )}
        {loaded.status === "ready" && roundId !== null && loaded.data === null && (
          <p className="p-4 text-sm text-warn">Round #{roundId.toString()} does not exist.</p>
        )}
        {loaded.status === "ready" && loaded.data && (
          <FairnessReport
            evidence={loaded.data.evidence}
            details={[
              { label: "state", value: loaded.data.phase },
              { label: "program", value: CRASH_PROGRAM_ID.toBase58() },
              { label: "randomness account", value: loaded.data.randomnessAccount },
              { label: "randomness seed slot", value: loaded.data.seedSlot.toString() },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
