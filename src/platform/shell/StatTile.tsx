import type { ReactNode } from "react";
import { STATUS_TONE_TEXT_CLASS, type StatusTone } from "./status-tone";

interface StatTileProps {
  label: string;
  value: string;
  /** Short context under the value, e.g. the window the figure covers. */
  hint?: ReactNode;
  tone?: StatusTone;
}

/** A single labeled figure. Tone only emphasizes; the value and label carry the meaning. */
export function StatTile({ label, value, hint, tone = "neutral" }: StatTileProps) {
  return (
    <div className="animate-rise-in rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-[11px] uppercase tracking-widest text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${STATUS_TONE_TEXT_CLASS[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
