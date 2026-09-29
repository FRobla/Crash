"use client";

import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import type { StatusTone } from "@/platform/shell/status-tone";
import { useCrashGame } from "./crash-game";
import { formatMultiplier } from "./multiplier-text";
import { roundDisplay, type RoundDisplay } from "./round-view";
import { useEstimatedTick } from "./use-estimated-tick";

const GRID_ROWS = 4;
const GRID_COLUMNS = 8;

const CONNECTION: Record<string, { value: string; tone: StatusTone }> = {
  connecting: { value: "connecting", tone: "warn" },
  live: { value: "live", tone: "ok" },
  stale: { value: "stale", tone: "danger" },
};

function headline(display: RoundDisplay): { big: string; small: string; tone: string; sr: string } {
  switch (display.kind) {
    case "idle":
      return { big: "—.——x", small: "idle · waiting for the next round", tone: "text-muted", sr: "No round in progress" };
    case "betting":
      return {
        big: "1.00x",
        small: `betting open · closes in ~${display.secondsLeft}s`,
        tone: "text-fg",
        sr: `Betting open, closes in about ${display.secondsLeft} seconds`,
      };
    case "awaiting-entropy":
      return { big: "1.00x", small: "betting closed · waiting for randomness", tone: "text-muted", sr: "Waiting for randomness" };
    case "running":
      return {
        big: formatMultiplier(display.multiplier),
        small: "running · estimated from the slot clock",
        tone: "text-accent",
        sr: `Running, estimated multiplier ${formatMultiplier(display.multiplier)}`,
      };
    case "crashed":
      return {
        big: formatMultiplier(display.crashPoint),
        small: "crashed · revealed on-chain",
        tone: "text-danger",
        sr: `Crashed at ${formatMultiplier(display.crashPoint)}`,
      };
    case "voided":
      return { big: "void", small: "round voided · stakes refunded", tone: "text-warn", sr: "Round voided, stakes refunded" };
    case "forfeited":
      return {
        big: "forfeit",
        small: "not revealed in time · settled by the forfeit rule",
        tone: "text-warn",
        sr: "Round forfeited",
      };
  }
}

/**
 * Round view. The multiplier while running is a projection of the settlement clock; the crash
 * point shown is always the one revealed on-chain.
 */
export function CrashConsole() {
  const game = useCrashGame();
  const tick = useEstimatedTick(game);
  const round = game.round;
  const display = roundDisplay(round, tick);
  const text = headline(display);
  const connection = CONNECTION[game.connection];

  return (
    <Panel
      titleId="crash-console-title"
      title="Crash"
      meta={
        <>
          <StatusItem label="round" value={round ? `#${round.roundId}` : "#—"} />
          <StatusItem label="commit" value={round ? `${round.commitHex.slice(0, 10)}…` : "—"} />
          <StatusItem label="state" value={round?.phase ?? "idle"} />
          <StatusItem label="feed" value={connection.value} tone={connection.tone} />
        </>
      }
    >
      <div className="relative h-64 sm:h-80">
        <MultiplierGrid />
        <div className="relative flex h-full flex-col items-center justify-center gap-2 px-4">
          <p className={`text-5xl font-semibold tabular-nums sm:text-7xl ${text.tone}`}>
            <span aria-hidden="true">{text.big}</span>
            <span className="sr-only">{text.sr}</span>
          </p>
          <p className="text-sm text-muted">{text.small}</p>
          {game.paused && <p className="text-sm text-warn">The house is paused: no new rounds or bets.</p>}
          {round && (
            <p className="text-xs text-muted">
              {round.betCount} bet{round.betCount === 1 ? "" : "s"} in round #{round.roundId.toString()}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function MultiplierGrid() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full text-border"
      viewBox="0 0 800 320"
      preserveAspectRatio="none"
    >
      {Array.from({ length: GRID_ROWS - 1 }, (_, index) => {
        const y = ((index + 1) * 320) / GRID_ROWS;
        return (
          <line
            key={`row-${y}`}
            x1="0"
            x2="800"
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {Array.from({ length: GRID_COLUMNS - 1 }, (_, index) => {
        const x = ((index + 1) * 800) / GRID_COLUMNS;
        return (
          <line
            key={`column-${x}`}
            x1={x}
            x2={x}
            y1="0"
            y2="320"
            stroke="currentColor"
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {/* Baseline at 1.00x, where every round starts. */}
      <line
        x1="0"
        x2="800"
        y1="319"
        y2="319"
        className="text-accent/40"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
