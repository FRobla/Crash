import type { ReactNode } from "react";

interface PanelProps {
  /** Id for the heading, used to label the section for assistive technology. */
  titleId: string;
  title: string;
  /** Optional content aligned to the right of the header, e.g. status items. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ titleId, title, meta, children, className = "" }: PanelProps) {
  return (
    <section aria-labelledby={titleId} className={`border border-border bg-surface ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-xs">
        <h2 id={titleId} className="uppercase tracking-widest text-muted">
          {title}
        </h2>
        {meta && <div className="flex flex-wrap gap-x-4 gap-y-1">{meta}</div>}
      </header>
      {children}
    </section>
  );
}
