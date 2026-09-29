"use client";

import { Activity, Rocket, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import type { StatusTone } from "@/platform/shell/status-tone";
import type { RoundPhase } from "../domain/round-lifecycle";
import { formatCoins } from "@/platform/player-accounts/coins";
import { ONE_X, payoutFor, type Multiplier } from "../domain/units";
import { toNumber } from "./chart-geometry";
import { CrashChart, TIER_TEXT } from "./CrashChart";
import { useCrashGame, type CrashGamePort, type LiveRound } from "./crash-game";
import { intensity, intensityTier, lastMilestone } from "./live-intensity";
import { formatMultiplier } from "./multiplier-text";
import {
  applyEarlyCrash,
  bettingMsLeft,
  bettingWindowMs,
  cashedOutAt,
  myBetOutcome,
  roundDisplay,
  type RoundDisplay,
  type ShownRound,
} from "./round-view";
import { playSound, setRise, setSoundEnabled, startRise, stopRise, useSoundEnabled } from "./sound";
import { useEarlyCrash } from "./use-early-crash";
import { useEstimatedTick } from "./use-estimated-tick";
import { useFrameValue, useReducedMotion } from "./use-frame-value";
import { usePlayout } from "./use-playout";
import { useShownMultiplier } from "./use-shown-multiplier";

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

/** Phases that share the top-left headline over the curve; the number is never remounted between them. */
const CURVE_KINDS: ReadonlySet<RoundDisplay["kind"]> = new Set(["launching", "running", "crashed"]);

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
  const live = usePlayout(applyEarlyCrash(game.round, early), game);
  const tick = useEstimatedTick(game, 250);
  const liveDisplay = roundDisplay(live, tick === null ? null : Number(tick), game.msPerTick());
  const { held, stage } = useCrashHold(live);
  const shown = held ?? live;
  const display = held ? roundDisplay(held, null, game.msPerTick()) : liveDisplay;
  const loading = !game.round && game.connection === "connecting";
  const connection = CONNECTION[game.connection];
  const feed = LIVE_FEED[game.liveFeed];
  useRoundSounds(display, shown?.roundId ?? null);
  const recordedCashOut = recordedCashOutIn(shown, game);
  useCashOutCue(recordedCashOut ? shown!.roundId : null);
  const curveLayout = !loading && CURVE_KINDS.has(display.kind);

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
        {recordedCashOut && display.kind === "running" && (
          <div
            key={`cash-out-flash-${shown!.roundId}`}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 animate-crash-flash bg-[radial-gradient(circle_at_center,rgb(74_222_128/0.35),transparent_70%)]"
          />
        )}
        {/*
          While a curve is drawn the headline sits top-left, the one area a rising curve never
          crosses. Launch, run and crash share that container, so the number stays in place.
        */}
        <div
          key={loading ? "loading" : curveLayout ? "curve" : display.kind}
          className={`pointer-events-none relative flex h-full animate-fade-in flex-col gap-2 px-4 ${
            curveLayout ? "items-start justify-start pt-5 pl-16 sm:pl-20" : "items-center justify-center pb-6"
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

/** The player's cash-out recorded on-chain in the round on screen, if any. */
function recordedCashOutIn(round: ShownRound | null, game: Pick<CrashGamePort, "myBet">): Multiplier | null {
  const bet = game.myBet;
  if (!round || !bet || bet.roundId !== round.roundId || bet.cashOutTick === null) return null;
  return cashedOutAt(round, bet);
}

/** The cash-out sound when a recorded cash-out first appears (not when the page loads with one). */
function useCashOutCue(roundId: bigint | null) {
  const previous = useRef<bigint | null | undefined>(undefined);
  useEffect(() => {
    const first = previous.current === undefined;
    const changed = previous.current !== roundId;
    previous.current = roundId;
    if (!first && changed && roundId !== null) playSound("cashout");
  }, [roundId]);
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
  if (CURVE_KINDS.has(display.kind)) return <CurveHeadline display={display} round={round} game={game} />;
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
 * Launch, run and crash in one place (spec crash-client-v1 §5.2): 1.00x waits at the origin, starts
 * counting there at take-off and turns red there at the crash.
 */
function CurveHeadline({ display, round, game }: { display: RoundDisplay; round: ShownRound | null; game: CrashGamePort }) {
  const recorded = recordedCashOutIn(round, game);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className={display.kind === "crashed" ? "animate-shake" : undefined}>
        <HeadlineNumber display={display} round={round} game={game} humming={display.kind === "running" && recorded === null} />
      </div>
      {display.kind === "launching" && (
        <>
          <div aria-hidden="true" className="h-0.5 w-40 overflow-hidden rounded-full bg-info/15">
            <div className="h-full w-1/3 animate-indeterminate rounded-full bg-info" />
          </div>
          <Caption>
            <Rocket aria-hidden="true" className="mr-1.5 inline size-3.5 animate-launch text-info" />
            <span className="text-fg">launching</span> · bets closed · waiting for verifiable randomness
          </Caption>
        </>
      )}
      {display.kind === "running" && <Caption>running · estimated from the slot clock</Caption>}
      {display.kind === "crashed" && (
        <div className="flex animate-rise-in flex-wrap items-center gap-2">
          <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.3em] text-danger">
            crashed
          </span>
          <Caption>
            {display.provisional ? "verified against the commit · on-chain reveal pending" : "revealed on-chain · verifiable"}
          </Caption>
        </div>
      )}
      {round && <CashOutMark round={round} game={game} at={recorded} />}
    </div>
  );
}

/**
 * The headline number. While running it shows the live multiplier every frame, colored by band,
 * growing and glowing with it, and pulsing at each milestone; the rise tone follows it.
 */
function HeadlineNumber({
  display,
  round,
  game,
  humming,
}: {
  display: RoundDisplay;
  round: ShownRound | null;
  game: CrashGamePort;
  humming: boolean;
}) {
  const reduced = useReducedMotion();
  const running = display.kind === "running";
  const live = useShownMultiplier(running ? round : null, game, running);
  const value = display.kind === "crashed" ? display.crashPoint : running ? live : ONE_X;
  const milestone = running ? lastMilestone(value) : null;
  useRiseTone(humming, value);
  useMilestoneCue(round?.roundId ?? null, milestone);

  const color = display.kind === "crashed" ? "text-danger" : running ? TIER_TEXT[intensityTier(value)] : "text-muted";
  // Stepped so the style only changes a few dozen times over a whole round.
  const grow = display.kind === "launching" ? 0 : Math.round(intensity(value) * 40) / 40;
  return (
    <p
      aria-hidden="true"
      className={`origin-top-left text-5xl font-semibold tracking-tight tabular-nums transition-[color,transform,filter] duration-300 sm:text-7xl ${color}`}
      style={{
        transform: reduced ? undefined : `scale(${1 + 0.3 * grow})`,
        filter:
          display.kind === "launching"
            ? undefined
            : `drop-shadow(0 0 ${Math.round(16 + 28 * grow)}px color-mix(in srgb, currentColor ${Math.round(35 + 35 * grow)}%, transparent))`,
      }}
    >
      <span key={milestone?.toString() ?? "none"} className={`inline-block origin-left ${milestone ? "motion-safe:animate-milestone" : ""}`}>
        {formatMultiplier(value)}
      </span>
    </p>
  );
}

/** The rise tone plays while `active` and glides with the multiplier shown. */
function useRiseTone(active: boolean, value: Multiplier) {
  useEffect(() => {
    if (!active) return;
    startRise();
    return () => stopRise();
  }, [active]);
  useEffect(() => {
    if (active) setRise(toNumber(value));
  }, [active, value]);
}

/** A short cue each time the running multiplier crosses a new milestone (not for ones already passed on load). */
function useMilestoneCue(roundId: bigint | null, milestone: Multiplier | null) {
  const seen = useRef<{ roundId: bigint | null; milestone: Multiplier | null } | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = { roundId, milestone };
    if (!previous || previous.roundId !== roundId || milestone === null) return;
    if (previous.milestone === null || milestone > previous.milestone) playSound("milestone");
  }, [roundId, milestone]);
}

/**
 * The player's recorded cash-out or win (manual or auto), in the headline. A record is not a win:
 * it pays only if the crash point is at least the recognized multiplier (crash-round-rules §6),
 * which the reveal decides.
 */
function CashOutMark({ round, game, at }: { round: ShownRound; game: CrashGamePort; at: Multiplier | null }) {
  const outcome = myBetOutcome(round, game.myBet);
  if (at === null && outcome.kind !== "cashed-out") return null;
  if (outcome.kind === "cashed-out") {
    return (
      <p
        key="won"
        className="flex animate-pop-in items-baseline gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-accent shadow-[0_0_28px_-6px] shadow-accent/60 backdrop-blur-sm"
      >
        <span className="text-xl font-semibold tabular-nums">+{formatCoins(outcome.payout)} coins</span>
        <span className="text-xs text-fg">won at {formatMultiplier(outcome.multiplier)} · pending settlement</span>
      </p>
    );
  }
  if (outcome.kind === "lost" && at !== null) {
    return (
      <p key="late" className="rounded bg-bg/60 px-2 text-sm text-muted backdrop-blur-sm">
        your cash-out at {formatMultiplier(at)} came after the crash
      </p>
    );
  }
  if (outcome.kind !== "open" || !game.myBet || at === null) return null;
  return (
    <p key="recorded" className="flex animate-pop-in items-baseline gap-2 rounded-md border border-accent/40 bg-bg/70 px-3 py-1.5 backdrop-blur-sm">
      <span className="text-lg font-semibold text-accent tabular-nums">cashed out {formatMultiplier(at)}</span>
      <span className="text-xs text-muted">
        {formatCoins(payoutFor(game.myBet.stake, at))} coins if the crash point is ≥ {formatMultiplier(at)}
      </span>
    </p>
  );
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
