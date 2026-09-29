import type { ReactNode } from "react";
import type { StatusTone } from "./status-tone";

interface PanelProps {
  /** Id for the heading, used to label the section for assistive technology. */
  titleId: string;
  title: string;
  /** Optional decorative icon before the title. */
  icon?: ReactNode;
  /** Optional content aligned to the right of the header, e.g. status items. */
  meta?: ReactNode;
  /** Highlights the panel edge; the state itself must also be written out inside the panel. */
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}

const TONE_EDGE: Record<StatusTone, string> = {
  neutral: "border-border",
  ok: "border-accent/45 shadow-[0_0_32px_-12px] shadow-accent/40",
  warn: "border-warn/45 shadow-[0_0_32px_-12px] shadow-warn/40",
  danger: "border-danger/45 shadow-[0_0_32px_-12px] shadow-danger/40",
};

export function Panel({ titleId, title, icon, meta, tone = "neutral", children, className = "" }: PanelProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-lg border bg-surface/95 transition-[border-color,box-shadow] duration-500 ${TONE_EDGE[tone]} ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-t-lg border-b border-border bg-surface-raised/40 px-4 py-2 text-xs">
        <h2 id={titleId} className="flex items-center gap-2 uppercase tracking-widest text-muted">
          {icon && (
            <span aria-hidden="true" className="text-fg/70">
              {icon}
            </span>
          )}
          {title}
        </h2>
        {meta && <div className="flex flex-wrap gap-x-4 gap-y-1">{meta}</div>}
      </header>
      {children}
    </section>
  );
}
