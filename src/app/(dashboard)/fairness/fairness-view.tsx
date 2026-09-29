"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { CRASH_PROGRAM_ID } from "@/chain-adapters/solana/crash-program/deployment";
import { useRoundEvidence } from "@/chain-adapters/solana/crash-program/use-round-data";
import { useCrashGame } from "@/games/crash/ui/crash-game";
import { FairnessReport } from "@/games/crash/ui/FairnessReport";
import { Panel } from "@/platform/shell/Panel";
import { SkeletonRows } from "@/platform/shell/SkeletonRows";

const U64_MAX = (1n << 64n) - 1n;

export function FairnessView({ requestedRound }: { requestedRound: string | null }) {
  const game = useCrashGame();
  const requested = requestedRound !== null && BigInt(requestedRound) <= U64_MAX ? BigInt(requestedRound) : null;
  const roundId = requested ?? game.recentRounds[0]?.roundId ?? null;
  const loaded = useRoundEvidence(roundId);
  const recent = game.recentRounds
    .filter((round) => round.phase === "crashed" || round.phase === "settled")
    .slice(0, 8)
    .map((round) => round.roundId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Fairness</h1>
      <Panel
        titleId="fairness-title"
        title={roundId === null ? "Verify a round" : `Verify round #${roundId}`}
        icon={<ShieldCheck className="size-3.5" />}
      >
        <form action="/fairness" className="flex flex-wrap items-end gap-2 border-b border-border p-4">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Round id
            <input
              name="round"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={roundId?.toString() ?? ""}
              className="w-40 rounded-md border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg transition-colors hover:border-border-strong focus:border-accent/60"
            />
          </label>
          <button type="submit" className="rounded-md border border-accent/50 bg-accent/15 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-accent transition-colors hover:bg-accent/25">
            Verify
          </button>
          {recent.length > 0 && (
            <nav aria-label="Recent rounds to verify" className="flex flex-wrap items-center gap-1.5 text-xs sm:ml-auto">
              <span className="text-muted">recent:</span>
              {recent.map((id) => (
                <Link
                  key={id.toString()}
                  href={`/fairness?round=${id}`}
                  aria-current={id === roundId ? "page" : undefined}
                  className="rounded border border-border px-1.5 py-0.5 tabular-nums text-muted transition-colors hover:border-border-strong hover:text-fg aria-[current=page]:border-accent/50 aria-[current=page]:text-accent"
                >
                  #{id.toString()}
                </Link>
              ))}
            </nav>
          )}
        </form>
        {roundId === null && <p className="p-4 text-sm text-muted">Enter a round id, or wait for the first round to finish.</p>}
        {roundId !== null && loaded.status === "loading" && (
          <div className="flex flex-col gap-4 p-4">
            <p className="text-sm text-muted">Loading round…</p>
            <SkeletonRows rows={6} />
          </div>
        )}
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
