"use client";

import { History } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/platform/shell/EmptyState";
import { Panel } from "@/platform/shell/Panel";
import { useCrashGame, type RoundSummary } from "./crash-game";
import { formatMultiplier } from "./multiplier-text";

function outcomeText(round: RoundSummary): { text: string; tone: string } {
  if (round.crashPoint !== null && (round.phase === "crashed" || round.phase === "settled")) {
    return { text: formatMultiplier(round.crashPoint), tone: round.crashPoint >= 20_000n ? "text-accent" : "text-danger" };
  }
  if (round.phase === "voided") return { text: "void", tone: "text-warn" };
  if (round.phase === "forfeited") return { text: "forfeit", tone: "text-warn" };
  return { text: round.phase, tone: "text-muted" };
}

/** Last finished rounds with their on-chain result and a link to verify each one. */
export function RoundFeed({ verifyHref }: { verifyHref: (roundId: bigint) => string }) {
  const { recentRounds } = useCrashGame();
  return (
    <Panel titleId="recent-rounds-title" title="Recent rounds">
      {recentRounds.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title="No rounds yet"
          description="Finished rounds appear here with their crash point and a link to verify them."
        />
      ) : (
        <ul className="flex flex-wrap gap-2 p-4">
          {recentRounds.map((round) => {
            const outcome = outcomeText(round);
            return (
              <li key={round.roundId.toString()}>
                <Link
                  href={verifyHref(round.roundId)}
                  className="inline-flex items-baseline gap-2 border border-border px-2 py-1 text-sm tabular-nums hover:border-accent"
                  title={`Verify round #${round.roundId}`}
                >
                  <span className="text-xs text-muted">#{round.roundId.toString()}</span>
                  <span className={outcome.tone}>{outcome.text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
