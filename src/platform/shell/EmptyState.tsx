import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
}

export function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className="flex animate-fade-in flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {icon && (
        <span
          aria-hidden="true"
          className="mb-1 grid size-10 place-items-center rounded-full border border-border bg-surface-raised text-muted"
        >
          {icon}
        </span>
      )}
      <p className="text-sm text-fg">{title}</p>
      <p className="max-w-sm text-xs text-muted">{description}</p>
    </div>
  );
}
