"use client";

import { Activity, Rocket, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import type { StatusTone } from "@/platform/shell/status-tone";
import type { RoundPhase } from "../domain/round-lifecycle";
import { rulesForVersion } from "../domain/rules";
import { interpolatedMultiplier } from "./chart-geometry";
import { CrashChart, PRESENTATION_LAG_TICKS } from "./CrashChart";
import { useCrashGame, type CrashGamePort, type LiveRound } from "./crash-game";
import { formatMultiplier } from "./multiplier-text";
import {
  applyEarlyCrash,
  bettingMsLeft,
  bettingWindowMs,
  cashedOutAt,
  curveForRules,
  multiplierAt,
  roundDisplay,
  type RoundDisplay,
  type ShownRound,
} from "./round-view";
import { playSound, setSoundEnabled, useSoundEnabled } from "./sound";
import { useEarlyCrash } from "./use-early-crash";
import { useEstimatedTick } from "./use-estimated-tick";
import { useFrameValue, useReducedMotion } from "./use-frame-value";

const CONNECTION: Record<string, { value: string; tone: StatusTone }> = {
  connecting: { value: "connecting", tone: "warn" },
  live: { value: "live", tone: "ok" },
  stale: { value: "stale", tone: "danger" },
};

const LIVE_FEED: Record<CrashGamePort["liveFeed"], { value: string; tone: StatusTone }> = {
  off: { value: "off", tone: "neutral" },
  connecting: { value: "connecting", tone: "warn" },
  live: { value: "live", tone: "ok" },
  down: { value: "down", tone: "warn" },
};

const PANEL_TONE: Record<RoundDisplay["kind"] | "loading", StatusTone> = {
  loading: "neutral",
  idle: "neutral",
  betting: "neutral",
  launching: "neutral",
  running: "ok",
  crashed: "danger",
  voided: "warn",
  forfeited: "warn",
};

const LIVE_ANNOUNCEMENT: Partial<Record<RoundDisplay["kind"], string>> = {
  betting: "Betting open",
  running: "Round running",
};

/** A crash stays on screen at least this long, even if the next round already takes bets. */
export const CRASH_HOLD_MS = 2_500;
const CRASH_FADE_MS = 600;

function screenReaderText(display: RoundDisplay): string {
  switch (display.kind) {
    case "idle":
      return "No round in progress";
    case "betting":
      return `Betting open, closes in about ${display.secondsLeft} seconds`;
    case "launching":
      return "Betting closed, launching once verifiable randomness arrives";
    case "running":
      return `Running, estimated multiplier ${formatMultiplier(display.multiplier)}`;
    case "crashed":
      return display.provisional
        ? `Crashed at ${formatMultiplier(display.crashPoint)}, verified, on-chain reveal pending`
        : `Crashed at ${formatMultiplier(display.crashPoint)}`;
    case "voided":
      return "Round voided, stakes refunded";
    case "forfeited":
      return "Round forfeited";
  }
}

type HoldStage = "hold" | "fade" | "done";

/**
 * Keeps the last crash visible for CRASH_HOLD_MS, then fades it out, even when the next round
 * opens sooner (spec crash-client-v1 §5.2). Presentation only.
 */
function useCrashHold(round: ShownRound | null): { held: ShownRound | null; stage: HoldStage } {
  const [held, setHeld] = useState<ShownRound | null>(null);
  const [stage, setStage] = useState<{ roundId: bigint | null; value: HoldStage }>({ roundId: null, value: "done" });
  const crashed = round !== null && (round.phase === "crashed" || round.phase === "settled") && round.crashPoint !== null;
  // Adjusting state during render: remember the newest crash (and its on-chain confirmation).
  if (crashed && (held?.roundId !== round.roundId || held.phase !== round.phase || held.provisional !== round.provisional)) {
    setHeld(round);
  }
  const heldId = held?.roundId ?? null;
  useEffect(() => {
    if (heldId === null) return;
    const fade = setTimeout(() => setStage({ roundId: heldId, value: "fade" }), CRASH_HOLD_MS);
    const done = setTimeout(() => setStage({ roundId: heldId, value: "done" }), CRASH_HOLD_MS + CRASH_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [heldId]);
  const current = stage.roundId === heldId ? stage.value : "hold";
  // Only a newer round is ever held back; the crashed round itself simply shows.
  if (!held || !round || round.roundId === held.roundId || round.roundId < held.roundId) return { held: null, stage: "done" };
  return { held: current === "done" ? null : held, stage: current };
}

/**
 * Round view. The multiplier while running is a projection of the settlement clock; the crash
 * point shown is the one revealed on-chain, or one verified against the on-chain commit and
 * labeled as pending the on-chain reveal.
 */
export function CrashConsole() {
  const game = useCrashGame();
  const early = useEarlyCrash(game);
  const live = applyEarlyCrash(game.round, early);
  const tick = useEstimatedTick(game, 250);
  const liveDisplay = roundDisplay(live, tick === null ? null : Number(tick), game.msPerTick());
  const { held, stage } = useCrashHold(live);
  const shown = held ?? live;
  const display = held ? roundDisplay(held, null, game.msPerTick()) : liveDisplay;
  const loading = !game.round && game.connection === "connecting";
  const connection = CONNECTION[game.connection];
  const feed = LIVE_FEED[game.liveFeed];
  useRoundSounds(display, shown?.roundId ?? null);

  return (
    <Panel
      titleId="crash-console-title"
      title="Crash"
      icon={<Activity className="size-3.5" />}
      tone={PANEL_TONE[loading ? "loading" : display.kind]}
      meta={
        <>
          <StatusItem label="round" value={game.round ? `#${game.round.roundId}` : "#—"} />
          <StatusItem label="commit" value={game.round ? `${game.round.commitHex.slice(0, 10)}…` : "—"} />
          <StatusItem label="state" value={game.round?.phase ?? (loading ? "loading" : "idle")} />
          <StatusItem label="feed" value={connection.value} tone={connection.tone} />
          {game.liveFeed !== "off" && <StatusItem label="crank" value={feed.value} tone={feed.tone} />}
          <SoundToggle />
        </>
      }
    >
      <PhaseTrack phase={game.round?.phase ?? null} />
      <div className="relative h-72 overflow-hidden sm:h-96">
        <CrashChart
          game={game}
          round={shown}
          display={display}
          fading={stage === "fade"}
          myBet={game.myBet}
          cashedOutAt={cashedOutAt(shown, game.myBet)}
        />
        {display.kind === "crashed" && shown && (
          <div
            key={`flash-${shown.roundId}`}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 animate-crash-flash bg-[radial-gradient(circle_at_center,rgb(248_113_113/0.45),transparent_70%)]"
          />
        )}
        {/* While a curve is drawn the headline sits top-left, the one area a rising curve never crosses. */}
        <div
          key={loading ? "loading" : display.kind}
          className={`pointer-events-none relative flex h-full animate-fade-in flex-col gap-2 px-4 ${
            display.kind === "running" || display.kind === "crashed"
              ? "items-start justify-start pt-5 pl-16 sm:pl-20"
              : "items-center justify-center pb-6"
          }`}
        >
          {LIVE_ANNOUNCEMENT[liveDisplay.kind] && <p className="sr-only">{screenReaderText(liveDisplay)}</p>}
          {/* Announces phase changes only; the ticking values would be too chatty. */}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {loading ? "Loading the live round" : (LIVE_ANNOUNCEMENT[liveDisplay.kind] ?? screenReaderText(liveDisplay))}
          </p>
          {loading ? (
            <HeadlineSkeleton />
          ) : (
            <Headline display={display} round={shown} game={game} />
          )}
          {held && live && live.phase === "betting" && (
            <Caption>
              next round <span className="text-fg">#{live.roundId.toString()}</span> · betting open
            </Caption>
          )}
          {game.paused && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-sm text-warn">
              The house is paused: no new rounds or bets.
            </p>
          )}
          {shown && !held && (
            <p className="rounded-full bg-bg/70 px-2.5 py-0.5 text-xs text-muted backdrop-blur-sm">
              {shown.betCount} bet{shown.betCount === 1 ? "" : "s"} in round #{shown.roundId.toString()}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Take-off and crash sounds on phase changes (never on first load). */
function useRoundSounds(display: RoundDisplay, roundId: bigint | null) {
  const previous = useRef<string | null>(null);
  const key = `${roundId}:${display.kind}`;
  useEffect(() => {
    const first = previous.current === null;
    previous.current = key;
    if (first) return;
    if (display.kind === "running") playSound("takeoff");
    if (display.kind === "crashed") playSound("crash");
  }, [display.kind, key]);
}

function SoundToggle() {
  const on = useSoundEnabled();
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Mute game sounds" : "Turn on game sounds"}
      title={on ? "Sounds on" : "Sounds off"}
      className="inline-flex items-center gap-1 text-muted transition-colors hover:text-fg aria-pressed:text-accent"
      onClick={() => setSoundEnabled(!on)}
    >
      {on ? <Volume2 aria-hidden="true" className="size-3.5" /> : <VolumeX aria-hidden="true" className="size-3.5" />}
      <span>sound</span>
    </button>
  );
}

function HeadlineSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col items-center gap-3">
      <span className="h-14 w-48 animate-pulse rounded-md bg-surface-raised sm:h-20 sm:w-64" />
      <span className="h-3 w-40 animate-pulse rounded bg-surface-raised" />
    </div>
  );
}

function Headline({ display, round, game }: { display: RoundDisplay; round: ShownRound | null; game: CrashGamePort }) {
  switch (display.kind) {
    case "idle":
      return (
        <>
          <BigNumber className="text-muted">—.——x</BigNumber>
          <Caption>idle · waiting for the next round</Caption>
        </>
      );
    case "betting":
      return round ? <BettingCountdown round={round} game={game} /> : null;
    case "launching":
      return (
        <>
          <p aria-hidden="true" className="flex items-center gap-3 text-5xl font-semibold tracking-tight text-muted sm:text-7xl">
            <Rocket className="size-9 animate-launch text-info sm:size-12" />
            1.00x
          </p>
          <div aria-hidden="true" className="h-0.5 w-40 overflow-hidden rounded-full bg-info/15">
            <div className="h-full w-1/3 animate-indeterminate rounded-full bg-info" />
          </div>
          <Caption>
            <span className="text-fg">launching</span> · bets closed · waiting for verifiable randomness
          </Caption>
        </>
      );
    case "running":
      return (
        <>
          {round && <LiveMultiplier round={round} game={game} />}
          <Caption>running · estimated from the slot clock</Caption>
        </>
      );
    case "crashed":
      return (
        <div key={`crashed-${round?.roundId}`} className="flex animate-shake flex-col items-start gap-1">
          <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.3em] text-danger">
            crashed
          </span>
          <BigNumber className="text-danger drop-shadow-[0_0_24px_rgb(248_113_113/0.35)]">
            {formatMultiplier(display.crashPoint)}
          </BigNumber>
          <Caption>
            {display.provisional ? "verified against the commit · on-chain reveal pending" : "revealed on-chain · verifiable"}
          </Caption>
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

/**
 * The running multiplier, continuous between ticks (presentation only; spec §5.2). It trails the
 * projection by the same lag as the curve, and with reduced motion shows whole ticks only.
 */
function LiveMultiplier({ round, game }: { round: LiveRound; game: CrashGamePort }) {
  const reduced = useReducedMotion();
  const rules = rulesForVersion(round.rulesVersion);
  const text = useFrameValue(() => {
    const tick = game.projectedTick();
    if (!rules || tick === null || round.startTick === null) return "1.00x";
    const relative = Math.max(0, tick - Number(round.startTick) - PRESENTATION_LAG_TICKS);
    if (reduced) return formatMultiplier(multiplierAt(rules, BigInt(Math.floor(relative))));
    const value = interpolatedMultiplier(curveForRules(rules), relative);
    // Truncated like recognized multipliers, so it never shows more than the curve reached.
    return `${(Math.floor(value * 100) / 100).toFixed(2)}x`;
  }, true);
  return <BigNumber className="text-accent drop-shadow-[0_0_24px_rgb(74_222_128/0.35)] tabular-nums">{text}</BigNumber>;
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

/** Continuous countdown ring with tenths; whole seconds with reduced motion. */
function BettingCountdown({ round, game }: { round: LiveRound; game: CrashGamePort }) {
  const reduced = useReducedMotion();
  const msLeft = useFrameValue(() => {
    const ms = bettingMsLeft(round, game.projectedTick(), game.msPerTick());
    // Tenths are enough for the label and ring; rounding keeps re-renders at ~10 Hz.
    return reduced ? Math.ceil(ms / 1000) * 1000 : Math.round(ms / 50) * 50;
  }, true);
  const total = Math.max(bettingWindowMs(round, game.msPerTick()), msLeft, 1);
  const seconds = Math.ceil(msLeft / 1000);
  const final = msLeft > 0 && msLeft <= 3_000;
  useEffect(() => {
    if (seconds >= 1 && seconds <= 3) playSound("tick");
  }, [seconds]);
  const label = reduced ? `${seconds}s` : `${(msLeft / 1000).toFixed(1)}s`;
  return (
    <>
      <div
        aria-hidden="true"
        className={`relative grid size-28 place-items-center ${final ? "animate-pulse-ring text-warn" : "text-accent"}`}
      >
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
            strokeDashoffset={RING_LENGTH * (1 - msLeft / total)}
          />
        </svg>
        <span className="text-3xl font-semibold tabular-nums">{label}</span>
      </div>
      <Caption>
        <span className="text-fg">betting open</span> · closes in ~{seconds}s
      </Caption>
    </>
  );
}

const STEPS: { label: string; phases: readonly RoundPhase[] }[] = [
  { label: "Bets", phases: ["betting"] },
  { label: "Launch", phases: ["awaiting-entropy"] },
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
      {aborted && <li className="ml-2 shrink-0 rounded border border-warn/40 px-1.5 text-warn">{phase}</li>}
    </ol>
  );
}
