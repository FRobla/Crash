import Link from "next/link";
import type { RoundPhase } from "../domain/round-lifecycle";
import { formatCoins } from "@/platform/player-accounts/coins";
import { formatMultiplier } from "./multiplier-text";

export interface RoundRowView {
  roundId: bigint;
  phase: RoundPhase;
  crashPoint: bigint | null;
  betCount: number;
}

export interface BetRowView {
  signature: string;
  roundId: bigint;
  stake: bigint;
  autoCashOut: bigint;
  outcome: "cashed-out" | "lost" | "refunded";
  multiplier: bigint;
  payout: bigint;
  blockTime: number | null;
}

const TABLE = "w-full text-left text-sm tabular-nums";
const HEAD = "py-1.5 pr-3 text-xs font-normal uppercase tracking-widest text-muted";

/** Last rounds from the settlement authority, each linked to its verification. */
export function RoundHistoryTable({ rows, verifyHref }: { rows: readonly RoundRowView[]; verifyHref: (roundId: bigint) => string }) {
  return (
    <table className={TABLE}>
      <caption className="sr-only">Recent rounds</caption>
      <thead>
        <tr>
          <th className={HEAD}>Round</th>
          <th className={HEAD}>State</th>
          <th className={HEAD}>Crash</th>
          <th className={HEAD}>Bets</th>
          <th className={HEAD}>
            <span className="sr-only">Verify</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.roundId.toString()} className="border-t border-border">
            <td className="py-1.5 pr-3">#{row.roundId.toString()}</td>
            <td className="py-1.5 pr-3 text-muted">{row.phase}</td>
            <td className="py-1.5 pr-3">{row.crashPoint === null ? "—" : formatMultiplier(row.crashPoint)}</td>
            <td className="py-1.5 pr-3">{row.betCount}</td>
            <td className="py-1.5">
              <Link className="text-xs text-accent underline" href={verifyHref(row.roundId)}>
                verify
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTCOME_TONE = { "cashed-out": "text-accent", lost: "text-danger", refunded: "text-warn" } as const;

/** The player's settled bets, as recorded by `BetSettled` events. */
export function MyBetsTable({ rows, explorerUrl }: { rows: readonly BetRowView[]; explorerUrl: (signature: string) => string }) {
  return (
    <table className={TABLE}>
      <caption className="sr-only">Your settled bets</caption>
      <thead>
        <tr>
          <th className={HEAD}>Round</th>
          <th className={HEAD}>Stake</th>
          <th className={HEAD}>Auto</th>
          <th className={HEAD}>Result</th>
          <th className={HEAD}>Payout</th>
          <th className={HEAD}>
            <span className="sr-only">Transaction</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.signature}-${row.roundId}`} className="border-t border-border">
            <td className="py-1.5 pr-3">#{row.roundId.toString()}</td>
            <td className="py-1.5 pr-3">{formatCoins(row.stake)}</td>
            <td className="py-1.5 pr-3 text-muted">{row.autoCashOut === 0n ? "—" : formatMultiplier(row.autoCashOut)}</td>
            <td className={`py-1.5 pr-3 ${OUTCOME_TONE[row.outcome]}`}>
              {row.outcome === "cashed-out" ? `won ${formatMultiplier(row.multiplier)}` : row.outcome}
            </td>
            <td className="py-1.5 pr-3">{formatCoins(row.payout)}</td>
            <td className="py-1.5">
              <a className="text-xs text-accent underline" href={explorerUrl(row.signature)} target="_blank" rel="noreferrer">
                tx
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
