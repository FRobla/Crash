"use client";

import { Activity } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import type { StatusTone } from "@/platform/shell/status-tone";
import type { RoundPhase } from "../domain/round-lifecycle";
import { CrashChart } from "./CrashChart";
import { useCrashGame } from "./crash-game";
import { formatMultiplier } from "./multiplier-text";
import { cashedOutAt, roundDisplay, type RoundDisplay } from "./round-view";
import { useLiveClock } from "./use-live-clock";

const CONNECTION: Record<string, { value: string; tone: StatusTone }> = {
  connecting: { value: "connecting", tone: "warn" },
  live: { value: "live", tone: "ok" },
  stale: { value: "stale", tone: "danger" },
};

const PANEL_TONE: Record<RoundDisplay["kind"], StatusTone> = {
  idle: "neutral",
  betting: "neutral",
  "awaiting-entropy": "neutral",
  running: "ok",
  crashed: "danger",
  voided: "warn",
  forfeited: "warn",
};

const LIVE_ANNOUNCEMENT: Partial<Record<RoundDisplay["kind"], string>> = {
  betting: "Betting open",
  running: "Round running",
};

function screenReaderText(display: RoundDisplay): string {
  switch (display.kind) {
    case "idle":
      return "No round in progress";
    case "betting":
      return `Betting open, closes in about ${display.secondsLeft} seconds`;
    case "awaiting-entropy":
      return "Waiting for randomness";
    case "running":
      return `Running, estimated multiplier ${formatMultiplier(display.multiplier)}`;
    case "crashed":
      return `Crashed at ${formatMultiplier(display.crashPoint)}`;
    case "voided":
      return "Round voided, stakes refunded";
    case "forfeited":
      return "Round forfeited";
  }
}

/**
 * Round view. The multiplier while running is a projection of the settlement clock; the crash
 * point shown is always the one revealed on-chain.
 */
export function CrashConsole() {
  const game = useCrashGame();
  const round = game.round;
  const clock = useLiveClock(game, round?.phase === "running");
  const display = roundDisplay(round, clock.tick);
  const connection = CONNECTION[game.connection];
  const bettingTotal = useBettingWindow(round?.roundId ?? null, display);

  return (
    <Panel
      titleId="crash-console-title"
      title="Crash"
      icon={<Activity className="size-3.5" />}
      tone={PANEL_TONE[display.kind]}
      meta={
        <>
          <StatusItem label="round" value={round ? `#${round.roundId}` : "#—"} />
          <StatusItem label="commit" value={round ? `${round.commitHex.slice(0, 10)}…` : "—"} />
          <StatusItem label="state" value={round?.phase ?? "idle"} />
          <StatusItem label="feed" value={connection.value} tone={connection.tone} />
        </>
      }
    >
      <PhaseTrack phase={round?.phase ?? null} />
      <div className="relative h-72 overflow-hidden sm:h-96">
        <CrashChart
          round={round}
          display={display}
          tick={clock.tick}
          fraction={clock.fraction}
          myBet={game.myBet}
          cashedOutAt={cashedOutAt(round, game.myBet)}
        />
        {display.kind === "crashed" && round && (
          <div key={`flash-${round.roundId}`} aria-hidden="true" className="pointer-events-none absolute inset-0 animate-crash-flash bg-[radial-gradient(circle_at_center,rgb(248_113_113/0.45),transparent_70%)]" />
        )}
        {/* While a curve is drawn the headline sits top-left, the one area a rising curve never crosses. */}
        <div
          className={`pointer-events-none relative flex h-full flex-col gap-2 px-4 ${
            display.kind === "running" || display.kind === "crashed"
              ? "items-start justify-start pt-5 pl-16 sm:pl-20"
              : "items-center justify-center pb-6"
          }`}
        >
          {LIVE_ANNOUNCEMENT[display.kind] && <p className="sr-only">{screenReaderText(display)}</p>}
          {/* Announces phase changes only; the ticking values would be too chatty. */}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {LIVE_ANNOUNCEMENT[display.kind] ?? screenReaderText(display)}
          </p>
          <Headline display={display} roundId={round?.roundId ?? null} bettingTotal={bettingTotal} />
          {game.paused && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-sm text-warn">
              The house is paused: no new rounds or bets.
            </p>
          )}
          {round && (
            <p className="rounded-full bg-bg/70 px-2.5 py-0.5 text-xs text-muted backdrop-blur-sm">
              {round.betCount} bet{round.betCount === 1 ? "" : "s"} in round #{round.roundId.toString()}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Largest betting countdown seen for the round, used as the full length of the countdown ring. */
function useBettingWindow(roundId: bigint | null, display: RoundDisplay): number {
  const [betWindow, setBetWindow] = useState<{ roundId: bigint | null; total: number }>({ roundId: null, total: 0 });
  if (display.kind === "betting" && (betWindow.roundId !== roundId || display.secondsLeft > betWindow.total)) {
    setBetWindow({ roundId, total: display.secondsLeft });
  }
  return betWindow.roundId === roundId ? betWindow.total : 0;
}

function Headline({ display, roundId, bettingTotal }: { display: RoundDisplay; roundId: bigint | null; bettingTotal: number }) {
  switch (display.kind) {
    case "idle":
      return (
        <>
          <BigNumber className="text-muted">—.——x</BigNumber>
          <Caption>idle · waiting for the next round</Caption>
        </>
      );
    case "betting":
      return (
        <>
          <Countdown secondsLeft={display.secondsLeft} total={bettingTotal} />
          <Caption>
            <span className="text-fg">betting open</span> · closes in ~{display.secondsLeft}s
          </Caption>
        </>
      );
    case "awaiting-entropy":
      return (
        <>
          <BigNumber className="text-muted">1.00x</BigNumber>
          <div aria-hidden="true" className="h-0.5 w-40 overflow-hidden rounded-full bg-info/15">
            <div className="h-full w-1/3 animate-indeterminate rounded-full bg-info" />
          </div>
          <Caption>betting closed · waiting for verifiable randomness</Caption>
        </>
      );
    case "running":
      return (
        <>
          <BigNumber className="text-accent drop-shadow-[0_0_24px_rgb(74_222_128/0.35)]">
            {formatMultiplier(display.multiplier)}
          </BigNumber>
          <Caption>running · estimated from the slot clock</Caption>
        </>
      );
    case "crashed":
      return (
        <div key={`crashed-${roundId}`} className="flex animate-shake flex-col items-start gap-1">
          <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.3em] text-danger">
            crashed
          </span>
          <BigNumber className="text-danger drop-shadow-[0_0_24px_rgb(248_113_113/0.35)]">
            {formatMultiplier(display.crashPoint)}
          </BigNumber>
          <Caption>revealed on-chain · verifiable</Caption>
        </div>
      );
    case "voided":
      return (
        <>
          <BigNumber className="text-warn">void</BigNumber>
          <Caption>round voided · stakes refunded</Caption>
        </>
      );
    case "forfeited":
      return (
        <>
          <BigNumber className="text-warn">forfeit</BigNumber>
          <Caption>not revealed in time · settled by the forfeit rule</Caption>
        </>
      );
  }
}

function BigNumber({ children, className }: { children: ReactNode; className: string }) {
  return (
    <p aria-hidden="true" className={`text-5xl font-semibold tracking-tight sm:text-7xl ${className}`}>
      {children}
    </p>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="rounded bg-bg/60 px-2 text-sm text-muted backdrop-blur-sm">{children}</p>;
}

const RING_RADIUS = 34;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function Countdown({ secondsLeft, total }: { secondsLeft: number; total: number }) {
  const ratio = total > 0 ? secondsLeft / total : 1;
  const tone = secondsLeft <= 3 ? "text-warn" : "text-accent";
  return (
    <div aria-hidden="true" className={`relative grid size-24 place-items-center ${tone}`}>
      <svg viewBox="0 0 80 80" className="absolute inset-0 -rotate-90">
        <circle cx="40" cy="40" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="4" />
        <circle
          cx="40"
          cy="40"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - ratio)}
          className="transition-[stroke-dashoffset] duration-500 ease-linear"
        />
      </svg>
      <span className="text-3xl font-semibold tabular-nums">{secondsLeft}s</span>
    </div>
  );
}

const STEPS: { label: string; phases: readonly RoundPhase[] }[] = [
  { label: "Bets", phases: ["betting"] },
  { label: "Randomness", phases: ["awaiting-entropy"] },
  { label: "Live", phases: ["running"] },
  { label: "Revealed", phases: ["crashed"] },
  { label: "Settled", phases: ["settled"] },
];

/** Where the round is in its lifecycle, as recorded by the settlement authority. */
function PhaseTrack({ phase }: { phase: RoundPhase | null }) {
  const current = phase === null ? -1 : STEPS.findIndex((step) => step.phases.includes(phase));
  const aborted = phase === "voided" || phase === "forfeited";
  return (
    <ol aria-label="Round progress" className="flex items-center gap-1 border-b border-border px-4 py-2 text-[11px]">
      {STEPS.map((step, index) => {
        const done = current > index;
        const active = current === index;
        return (
          <li key={step.label} aria-current={active ? "step" : undefined} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full transition-colors duration-300 ${
                active ? "animate-live-dot bg-accent" : done ? "bg-accent/50" : "bg-border-strong"
              }`}
            />
            <span className={`truncate ${active ? "text-fg" : done ? "text-muted" : "text-muted/60"}`}>{step.label}</span>
            {index < STEPS.length - 1 && (
              <span aria-hidden="true" className={`h-px min-w-2 flex-1 ${done ? "bg-accent/40" : "bg-border"}`} />
            )}
          </li>
        );
      })}
      {aborted && (
        <li className="ml-2 shrink-0 rounded border border-warn/40 px-1.5 text-warn">{phase}</li>
      )}
    </ol>
  );
}
