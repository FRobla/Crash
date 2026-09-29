"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface TopBarProps {
  networkBadge: ReactNode;
  walletControl: ReactNode;
}

export function TopBar({ networkBadge, walletControl }: TopBarProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur">
      <p className="min-w-0 truncate text-sm" aria-label="Current location">
        <span className="text-muted">~</span>
        {pathname}
        <span aria-hidden="true" className="ml-1 animate-live-dot text-accent">
          _
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {networkBadge}
        {walletControl}
      </div>
    </header>
  );
}
