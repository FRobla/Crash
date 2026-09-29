import type { StatusTone } from "./status-tone";

const FILL: Record<StatusTone, string> = {
  neutral: "bg-fg/60",
  ok: "bg-accent",
  warn: "bg-warn",
  danger: "bg-danger",
};

const TRACK: Record<StatusTone, string> = {
  neutral: "bg-fg/10",
  ok: "bg-accent/15",
  warn: "bg-warn/15",
  danger: "bg-danger/15",
};

/**
 * Horizontal fill bar. Purely visual: callers always print the value it represents as text next
 * to it, so it is hidden from assistive technology.
 */
export function Meter({ ratio, tone = "ok", className = "" }: { ratio: number; tone?: StatusTone; className?: string }) {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return (
    <div aria-hidden="true" className={`h-1.5 w-full overflow-hidden rounded-full ${TRACK[tone]} ${className}`}>
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-out ${FILL[tone]}`}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}
