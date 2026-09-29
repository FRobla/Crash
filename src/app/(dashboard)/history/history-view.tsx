"use client";

import { useMyBetHistory, useRoundHistory } from "@/chain-adapters/solana/crash-program/use-round-data";
import { useCrashGame } from "@/games/crash/ui/crash-game";
import { MyBetsTable, RoundHistoryTable } from "@/games/crash/ui/HistoryTables";
import { Panel } from "@/platform/shell/Panel";

export function HistoryView() {
  const game = useCrashGame();
  const rounds = useRoundHistory(game.round?.roundId ?? null);
  // Refresh the player's bets whenever a new round shows up.
  const bets = useMyBetHistory(20, game.round?.roundId ?? null);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">History</h1>
      <Panel titleId="history-rounds-title" title="Rounds">
        <div className="overflow-x-auto p-4">
          {rounds.status === "loading" && <p className="text-sm text-muted">Loading rounds…</p>}
          {rounds.status === "error" && <p className="text-sm text-danger">Could not load rounds from the RPC.</p>}
          {rounds.status === "ready" && (
            <RoundHistoryTable rows={rounds.data} verifyHref={(roundId) => `/fairness?round=${roundId}`} />
          )}
        </div>
      </Panel>
      <Panel titleId="history-bets-title" title="Your bets">
        <div className="overflow-x-auto p-4">
          {bets === null && <p className="text-sm text-muted">Connect a wallet to see your bets.</p>}
          {bets?.status === "loading" && <p className="text-sm text-muted">Loading your bets…</p>}
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
