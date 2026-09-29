"use client";

import { useId, useState, type PointerEvent } from "react";
import { rulesForVersion } from "../domain/rules";
import type { Multiplier } from "../domain/units";
import type { CrashGamePort, LiveRound, MyBet } from "./crash-game";
import {
  axisMultiplierLabel,
  chartDomains,
  curveSamples,
  lastTickAtOrBelow,
  niceTicks,
  toNumber,
  type CurvePoint,
} from "./chart-geometry";
import { intensityTier, type IntensityTier } from "./live-intensity";
import { formatMultiplier } from "./multiplier-text";
import { presentationLag, presentedTick } from "./presentation-lag";
import { curveForRules, multiplierAt, type RoundDisplay, type ShownRound } from "./round-view";
import { useElementSize } from "./use-element-size";
import { useFrameValue, useReducedMotion } from "./use-frame-value";

const PAD = { left: 46, right: 18, top: 18, bottom: 26 };

interface CrashChartProps {
  game: Pick<CrashGamePort, "projectedTick" | "msPerTick">;
  round: ShownRound | null;
  display: RoundDisplay;
  /** The held crash is fading out towards the next round's countdown. */
  fading: boolean;
  myBet: MyBet | null;
  /** Recognized multiplier of the player's recorded cash-out in this round, if any. */
  cashedOutAt: Multiplier | null;
}

interface Series {
  samples: CurvePoint[];
  tone: "launching" | "running" | "crashed";
}

export const TIER_TEXT: Record<IntensityTier, string> = {
  calm: "text-accent",
  warm: "text-warn",
  hot: "text-hot",
};

function seriesFor(round: LiveRound | null, display: RoundDisplay, relativeTick: number | null): Series | null {
  // Waiting for take-off: the tip rests at the origin, where the curve will start.
  if (round && display.kind === "launching") return { samples: [{ tick: 0, value: 1 }], tone: "launching" };
  if (!round || round.startTick === null) return null;
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules) return null;
  const curve = curveForRules(rules);
  if (display.kind === "running" && relativeTick !== null) {
    return { samples: curveSamples(curve, Math.max(0, relativeTick)), tone: "running" };
  }
  if (display.kind === "crashed") {
    const last = lastTickAtOrBelow(curve, display.crashPoint);
    return { samples: curveSamples(curve, last + 1, display.crashPoint), tone: "crashed" };
  }
  return null;
}

/**
 * Live multiplier chart: the rules' curve drawn up to the projected tick while a round runs, and
 * up to the crash point once it ends. Presentation of the port's data only; it subscribes to
 * animation frames itself, so only the chart re-renders at frame rate.
 */
export function CrashChart({ game, round, display, fading, myBet, cashedOutAt }: CrashChartProps) {
  const [containerRef, measured] = useElementSize<HTMLDivElement>();
  const gradientId = useId();
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const reduced = useReducedMotion();
  const startTick = round?.startTick ?? null;
  const roundId = round?.roundId ?? null;
  // A crash already known while the curve plays out caps it at the crash tick.
  const crashTick = round?.crashTick ?? null;
  const running = display.kind === "running" && startTick !== null;
  const relativeTick = useFrameValue(() => {
    const tick = game.projectedTick();
    if (tick === null || startTick === null || roundId === null) return null;
    const presented = presentedTick(startTick, tick, presentationLag.forRound(roundId));
    const relative = crashTick === null ? presented : Math.min(presented, Number(crashTick));
    return reduced ? Math.floor(relative) : relative;
  }, running);
  const secondsPerTick = game.msPerTick() / 1000;

  const series = seriesFor(round, display, running ? relativeTick : null);
  const samples = series?.samples ?? [];
  const lastSample = samples.at(-1);
  const betInRound = myBet !== null && round !== null && myBet.roundId === round.roundId;
  const auto = betInRound && myBet.autoCashOut !== 0n ? toNumber(myBet.autoCashOut) : null;
  const cashOut = betInRound && cashedOutAt !== null && myBet.cashOutTick !== null ? { tick: Number(myBet.cashOutTick), value: toNumber(cashedOutAt) } : null;

  const domains = chartDomains(lastSample?.tick ?? 0, lastSample?.value ?? 1);
  const { width, height } = measured ?? { width: 0, height: 0 };
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const x = (tickValue: number) => PAD.left + (tickValue / domains.x.max) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - ((value - domains.y.min) / (domains.y.max - domains.y.min)) * plotHeight;
  const baseline = y(1);

  const seconds = { min: 0, max: domains.x.max * secondsPerTick };
  const xTicks = niceTicks(seconds, Math.max(2, Math.floor(plotWidth / 90)));
  const yTicks = niceTicks(domains.y, Math.max(2, Math.floor(plotHeight / 55)));

  const line = samples.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.tick).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = lastSample ? `${line} L${x(lastSample.tick).toFixed(1)},${baseline} L${x(0)},${baseline} Z` : "";
  const toneClass =
    series?.tone === "crashed"
      ? "text-danger"
      : series?.tone === "launching"
        ? "text-muted"
        : TIER_TEXT[intensityTier(BigInt(Math.floor((lastSample?.value ?? 1) * 100)) * 100n)];

  const hover = hoverTick !== null && round && series && series.tone !== "launching" ? hoverPoint(round, hoverTick) : null;

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!lastSample) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const tickAtPointer = Math.round(((event.clientX - bounds.left - PAD.left) / plotWidth) * domains.x.max);
    setHoverTick(tickAtPointer < 0 || tickAtPointer > Math.floor(lastSample.tick) ? null : tickAtPointer);
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      {measured && (
        <svg
          aria-hidden="true"
          width={width}
          height={height}
          className="block select-none"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverTick(null)}
        >
          <defs>
            {/* The stops resolve currentColor where the gradient is defined, so it carries the tone. */}
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1" className={toneClass}>
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
  
          {/* Recessive grid and axes. */}
          <g className="text-grid">
            {yTicks.map((value) => (
              <line key={`y-${value}`} x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke="currentColor" />
            ))}
            {xTicks.map((value) => {
              const px = x(value / secondsPerTick);
              return <line key={`x-${value}`} x1={px} x2={px} y1={PAD.top} y2={baseline} stroke="currentColor" />;
            })}
          </g>
          <line x1={PAD.left} x2={width - PAD.right} y1={baseline} y2={baseline} className="text-border-strong" stroke="currentColor" />
          <g className="fill-muted text-[10px] tabular-nums">
            {yTicks.map((value) => (
              <text key={`yl-${value}`} x={PAD.left - 8} y={y(value)} dy="0.32em" textAnchor="end">
                {axisMultiplierLabel(value)}
              </text>
            ))}
            {xTicks.map((value) => (
              <text key={`xl-${value}`} x={x(value / secondsPerTick)} y={height - 8} textAnchor="middle">
                {value === 0 ? "0" : `${value}s`}
              </text>
            ))}
          </g>
  
          {/* The player's auto cash-out target. */}
          {auto !== null && (
            <g className="text-warn">
              {auto <= domains.y.max ? (
                <>
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(auto)} y2={y(auto)} stroke="currentColor" strokeOpacity="0.7" strokeDasharray="6 5" />
                  <text x={width - PAD.right - 4} y={y(auto) - 6} textAnchor="end" className="fill-fg text-[10px]">
                    your auto {axisMultiplierLabel(auto)}
                  </text>
                </>
              ) : (
                <text x={width - PAD.right - 4} y={PAD.top + 10} textAnchor="end" className="fill-muted text-[10px]">
                  your auto {axisMultiplierLabel(auto)} ↑
                </text>
              )}
            </g>
          )}
  
          {series && lastSample && (
            <g className={`${toneClass} transition-[color,opacity] duration-500 ${fading ? "opacity-0" : "opacity-100"}`}>
              <path d={area} fill={`url(#${gradientId})`} />
              <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(lastSample.tick)} cy={y(lastSample.value)} r="5" className="stroke-surface" fill="currentColor" strokeWidth="2" />
              {series.tone !== "crashed" && (
                <circle cx={x(lastSample.tick)} cy={y(lastSample.value)} r="5" fill="none" stroke="currentColor" strokeWidth="1.5" className="animate-halo" />
              )}
              {series.tone === "crashed" && round && (
                <circle
                  key={`burst-${round.roundId}`}
                  cx={x(lastSample.tick)}
                  cy={y(lastSample.value)}
                  r="5"
                  fill="none"
                  stroke="currentColor"
                  className="opacity-0 motion-safe:animate-burst"
                />
              )}
            </g>
          )}
  
          {/* The player's recorded cash-out on the curve. */}
          {cashOut && cashOut.tick <= domains.x.max && (
            <g className="text-accent">
              <circle cx={x(cashOut.tick)} cy={y(cashOut.value)} r="6" fill="currentColor" className="stroke-surface" strokeWidth="2" />
              <text x={x(cashOut.tick)} y={y(cashOut.value) - 12} textAnchor="middle" className="fill-fg text-[11px] font-semibold">
                you · {axisMultiplierLabel(cashOut.value)}
              </text>
            </g>
          )}
  
          {hover && (
            <g className="text-muted">
              <line x1={x(hover.tick)} x2={x(hover.tick)} y1={PAD.top} y2={baseline} stroke="currentColor" strokeOpacity="0.6" />
              <circle cx={x(hover.tick)} cy={y(hover.value)} r="4" fill="currentColor" className="stroke-surface" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-border-strong bg-surface-raised px-2 py-1 text-[11px] tabular-nums shadow-lg"
          style={{
            left: Math.min(x(hover.tick) + 10, width - 130),
            top: Math.max(PAD.top, y(hover.value) - 36),
          }}
        >
          <span className="text-muted">~{(hover.tick * secondsPerTick).toFixed(1)}s · </span>
          {formatMultiplier(hover.recognized)}
        </div>
      )}
    </div>
  );
}

function hoverPoint(round: LiveRound, tick: number) {
  const rules = rulesForVersion(round.rulesVersion);
  if (!rules) return null;
  const recognized = multiplierAt(rules, BigInt(tick));
  const capped = round.crashPoint !== null && recognized > round.crashPoint ? round.crashPoint : recognized;
  return { tick, value: toNumber(capped), recognized: capped };
}
