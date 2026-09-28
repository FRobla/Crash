import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
}

export function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {icon && (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      )}
      <p className="text-sm text-fg">{title}</p>
      <p className="max-w-sm text-xs text-muted">{description}</p>
    </div>
  );
}
