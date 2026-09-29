import { ExternalLink, ShieldCheck } from "lucide-react";
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
const HEAD = "px-2 py-2 text-[11px] font-normal uppercase tracking-widest text-muted first:pl-0";
const CELL = "px-2 py-2 first:pl-0";
const ROW = "border-t border-border transition-colors hover:bg-surface-raised/50";
const BADGE = "inline-block rounded border px-1.5 py-px text-xs";

function crashBadge(crashPoint: bigint | null): string {
  if (crashPoint === null) return "border-border text-muted";
  return crashPoint >= 20_000n ? "border-accent/30 bg-accent/10 text-accent" : "border-danger/30 bg-danger/10 text-danger";
}

const PHASE_TONE: Partial<Record<RoundPhase, string>> = {
  running: "text-accent",
  betting: "text-fg",
  voided: "text-warn",
  forfeited: "text-warn",
};

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
          <tr key={row.roundId.toString()} className={ROW}>
            <td className={CELL}>#{row.roundId.toString()}</td>
            <td className={`${CELL} ${PHASE_TONE[row.phase] ?? "text-muted"}`}>{row.phase}</td>
            <td className={CELL}>
              <span className={`${BADGE} ${crashBadge(row.crashPoint)}`}>
                {row.crashPoint === null ? "—" : formatMultiplier(row.crashPoint)}
              </span>
            </td>
            <td className={CELL}>{row.betCount}</td>
            <td className={`${CELL} text-right`}>
              <Link className="inline-flex items-center gap-1 text-xs text-accent hover:underline" href={verifyHref(row.roundId)}>
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                verify
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTCOME_BADGE = {
  "cashed-out": "border-accent/30 bg-accent/10 text-accent",
  lost: "border-danger/30 bg-danger/10 text-danger",
  refunded: "border-warn/30 bg-warn/10 text-warn",
} as const;

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
          <th className={HEAD}>Net</th>
          <th className={HEAD}>
            <span className="sr-only">Transaction</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const net = row.payout - row.stake;
          return (
            <tr key={`${row.signature}-${row.roundId}`} className={ROW}>
              <td className={CELL}>#{row.roundId.toString()}</td>
              <td className={CELL}>{formatCoins(row.stake)}</td>
              <td className={`${CELL} text-muted`}>{row.autoCashOut === 0n ? "—" : formatMultiplier(row.autoCashOut)}</td>
              <td className={CELL}>
                <span className={`${BADGE} ${OUTCOME_BADGE[row.outcome]}`}>
                  {row.outcome === "cashed-out" ? `won ${formatMultiplier(row.multiplier)}` : row.outcome}
                </span>
              </td>
              <td className={CELL}>{formatCoins(row.payout)}</td>
              <td className={`${CELL} ${net > 0n ? "text-accent" : net < 0n ? "text-danger" : "text-muted"}`}>
                {net > 0n ? "+" : ""}
                {formatCoins(net)}
              </td>
              <td className={`${CELL} text-right`}>
                <a
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  href={explorerUrl(row.signature)}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
