"use client";

import { History } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/platform/shell/EmptyState";
import { Panel } from "@/platform/shell/Panel";
import { CrashPointBars } from "./CrashPointBars";
import { useCrashGame, type RoundSummary } from "./crash-game";
import { crashPointStats } from "./history-stats";
import { formatMultiplier } from "./multiplier-text";

function outcomeText(round: RoundSummary): { text: string; tone: string } {
  if (round.crashPoint !== null && (round.phase === "crashed" || round.phase === "settled")) {
    return {
      text: formatMultiplier(round.crashPoint),
      tone: round.crashPoint >= 20_000n ? "border-accent/30 text-accent" : "border-danger/30 text-danger",
    };
  }
  if (round.phase === "voided") return { text: "void", tone: "border-warn/30 text-warn" };
  if (round.phase === "forfeited") return { text: "forfeit", tone: "border-warn/30 text-warn" };
  return { text: round.phase, tone: "border-border text-muted" };
}

/** Last finished rounds with their on-chain result and a link to verify each one. */
export function RoundFeed({ verifyHref }: { verifyHref: (roundId: bigint) => string }) {
  const { recentRounds } = useCrashGame();
  const stats = crashPointStats(recentRounds);
  return (
    <Panel
      titleId="recent-rounds-title"
      title="Recent rounds"
      icon={<History className="size-3.5" />}
      meta={
        stats.revealed > 0 ? (
          <span className="text-muted">
            ≥2x <span className="tabular-nums text-fg">{stats.atLeastTwo}/{stats.revealed}</span> · median{" "}
            <span className="tabular-nums text-fg">{stats.median === null ? "—" : formatMultiplier(stats.median)}</span> · high{" "}
            <span className="tabular-nums text-fg">{stats.highest === null ? "—" : formatMultiplier(stats.highest)}</span>
          </span>
        ) : undefined
      }
    >
      {recentRounds.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title="No rounds yet"
          description="Finished rounds appear here with their crash point and a link to verify them."
        />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <CrashPointBars rounds={recentRounds} verifyHref={verifyHref} />
          <ul className="flex flex-wrap gap-1.5" aria-label="Recent round results">
            {recentRounds.map((round, index) => {
              const outcome = outcomeText(round);
              return (
                <li key={round.roundId.toString()} className={index === 0 ? "animate-pop-in" : undefined}>
                  <Link
                    href={verifyHref(round.roundId)}
                    className={`inline-flex items-baseline gap-2 rounded-md border bg-surface-raised/40 px-2 py-1 text-sm tabular-nums transition-colors hover:bg-surface-raised ${outcome.tone}`}
                    title={`Verify round #${round.roundId}`}
                  >
                    <span className="text-xs text-muted">#{round.roundId.toString()}</span>
                    <span>{outcome.text}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
