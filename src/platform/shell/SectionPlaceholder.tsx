import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

interface SectionPlaceholderProps {
  title: string;
  emptyTitle: string;
  description: string;
  icon: ReactNode;
}

/** Page body for dashboard sections that are planned but not implemented yet. */
export function SectionPlaceholder({ title, emptyTitle, description, icon }: SectionPlaceholderProps) {
  return (
    <section className="border border-border bg-surface">
      <h1 className="border-b border-border px-4 py-2 text-xs uppercase tracking-widest text-muted">
        {title}
      </h1>
      <EmptyState icon={icon} title={emptyTitle} description={description} />
    </section>
  );
}
