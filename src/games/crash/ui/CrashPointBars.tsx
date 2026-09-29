import Link from "next/link";
import type { RoundPhase } from "../domain/round-lifecycle";
import type { Multiplier } from "../domain/units";
import { logRatio, toNumber } from "./chart-geometry";
import { formatMultiplier } from "./multiplier-text";

export interface CrashPointBar {
  roundId: bigint;
  phase: RoundPhase;
  crashPoint: Multiplier | null;
}

const TWO_X = 2;

function barView(round: CrashPointBar): { value: number | null; text: string; fill: string } {
  if (round.crashPoint !== null && (round.phase === "crashed" || round.phase === "settled")) {
    const value = toNumber(round.crashPoint);
    return { value, text: formatMultiplier(round.crashPoint), fill: value >= TWO_X ? "bg-accent" : "bg-danger" };
  }
  if (round.phase === "voided" || round.phase === "forfeited") return { value: null, text: round.phase, fill: "bg-warn" };
  return { value: null, text: round.phase, fill: "bg-border-strong" };
}

/**
 * Crash points of recent rounds on a log scale (oldest left), each bar linking to its
 * verification. Height encodes the value; color only repeats which side of 2.00x it fell on.
 */
export function CrashPointBars({ rounds, verifyHref }: { rounds: readonly CrashPointBar[]; verifyHref: (roundId: bigint) => string }) {
  const ordered = [...rounds].sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
  const views = ordered.map((round) => ({ round, ...barView(round) }));
  const scaleMax = Math.max(10, ...views.map((view) => view.value ?? 1));
  const twoLine = logRatio(TWO_X, scaleMax);

  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute inset-x-0 border-t border-dashed border-muted/40" style={{ bottom: `${twoLine * 100}%` }}>
          <span className="absolute -top-2 right-0 bg-surface px-1 text-[10px] text-muted">2.00x</span>
        </div>
      </div>
      {/* Mouse shortcut only: the results list or table next to it is the accessible equivalent. */}
      <ul aria-hidden="true" className="flex h-32 items-end justify-around gap-0.5 pr-12">
        {views.map(({ round, value, text, fill }, index) => {
          const ratio = value === null ? 0.04 : Math.max(0.03, logRatio(value, scaleMax));
          const newest = index === views.length - 1;
          return (
            <li key={round.roundId.toString()} className="group relative flex h-full max-w-6 min-w-1.5 flex-1 flex-col justify-end">
              <Link
                href={verifyHref(round.roundId)}
                tabIndex={-1}
                className="flex h-full items-end"
              >
                <span
                  className={`w-full origin-bottom animate-rise-in rounded-t-[4px] transition-opacity group-hover:opacity-100 ${fill} ${newest ? "opacity-100" : "opacity-75"}`}
                  style={{ height: `${ratio * 100}%` }}
                />
              </Link>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded border border-border-strong bg-surface-raised px-1.5 py-0.5 text-[11px] whitespace-nowrap tabular-nums shadow-lg group-hover:block"
              >
                <span className="text-muted">#{round.roundId.toString()} </span>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
