"use client";

import { ListOrdered, Receipt } from "lucide-react";
import { useMyBetHistory, useRoundHistory } from "@/chain-adapters/solana/crash-program/use-round-data";
import { useCrashGame } from "@/games/crash/ui/crash-game";
import { CrashPointBars } from "@/games/crash/ui/CrashPointBars";
import { MyBetsTable, RoundHistoryTable } from "@/games/crash/ui/HistoryTables";
import { crashPointStats, summarizeBets } from "@/games/crash/ui/history-stats";
import { formatMultiplier } from "@/games/crash/ui/multiplier-text";
import { formatCoins } from "@/platform/player-accounts/coins";
import { Panel } from "@/platform/shell/Panel";
import { SkeletonRows } from "@/platform/shell/SkeletonRows";
import { StatTile } from "@/platform/shell/StatTile";

const verifyHref = (roundId: bigint) => `/fairness?round=${roundId}`;

export function HistoryView() {
  const game = useCrashGame();
  const rounds = useRoundHistory(game.round?.roundId ?? null);
  // Refresh the player's bets whenever a new round shows up.
  const bets = useMyBetHistory(20, game.round?.roundId ?? null);

  const roundStats = rounds.status === "ready" ? crashPointStats(rounds.data) : null;
  const betSummary = bets?.status === "ready" && bets.data.length > 0 ? summarizeBets(bets.data) : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">History</h1>

      {(betSummary || roundStats) && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {betSummary && (
            <>
              <StatTile label="Your bets" value={String(betSummary.count)} hint={`${betSummary.won} won · ${betSummary.lost} lost`} />
              <StatTile
                label="Net result"
                value={`${betSummary.net > 0n ? "+" : ""}${formatCoins(betSummary.net)}`}
                tone={betSummary.net > 0n ? "ok" : betSummary.net < 0n ? "danger" : "neutral"}
                hint={`coins · last ${betSummary.count} bets, ${formatCoins(betSummary.staked)} staked`}
              />
            </>
          )}
          {roundStats && roundStats.revealed > 0 && (
            <>
              <StatTile
                label="Median crash"
                value={roundStats.median === null ? "—" : formatMultiplier(roundStats.median)}
                hint={`last ${roundStats.revealed} revealed rounds`}
              />
              <StatTile
                label="Rounds ≥ 2.00x"
                value={`${roundStats.atLeastTwo}/${roundStats.revealed}`}
                hint={roundStats.highest === null ? undefined : `highest ${formatMultiplier(roundStats.highest)}`}
              />
            </>
          )}
        </div>
      )}

      <Panel titleId="history-rounds-title" title="Rounds" icon={<ListOrdered className="size-3.5" />}>
        <div className="flex flex-col gap-4 overflow-x-auto p-4">
          {rounds.status === "loading" && (
            <>
              <p className="text-sm text-muted">Loading rounds…</p>
              <SkeletonRows />
            </>
          )}
          {rounds.status === "error" && <p className="text-sm text-danger">Could not load rounds from the RPC.</p>}
          {rounds.status === "ready" && (
            <>
              {rounds.data.length > 0 && <CrashPointBars rounds={rounds.data} verifyHref={verifyHref} />}
              <RoundHistoryTable rows={rounds.data} verifyHref={verifyHref} />
            </>
          )}
        </div>
      </Panel>
      <Panel titleId="history-bets-title" title="Your bets" icon={<Receipt className="size-3.5" />}>
        <div className="overflow-x-auto p-4">
          {bets === null && <p className="text-sm text-muted">Connect a wallet to see your bets.</p>}
          {bets?.status === "loading" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">Loading your bets…</p>
              <SkeletonRows rows={4} />
            </div>
          )}
          {bets?.status === "error" && <p className="text-sm text-danger">Could not load your bets from the RPC.</p>}
          {bets?.status === "ready" &&
            (bets.data.length === 0 ? (
              <p className="text-sm text-muted">No settled bets in your latest account activity.</p>
            ) : (
              <MyBetsTable rows={bets.data} explorerUrl={game.explorerUrl} />
            ))}
        </div>
      </Panel>
    </div>
  );
}
