import type { ReactNode } from "react";
import { Sidebar, type NavItem } from "./Sidebar";
import { TopBar } from "./TopBar";

interface DashboardShellProps {
  brand: string;
  navItems: readonly NavItem[];
  /** Chain-specific slots, composed by the app so the shell stays chain-agnostic. */
  networkBadge: ReactNode;
  walletControl: ReactNode;
  statusItems: ReactNode;
  children: ReactNode;
}

export function DashboardShell({
  brand,
  navItems,
  networkBadge,
  walletControl,
  statusItems,
  children,
}: DashboardShellProps) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar brand={brand} items={navItems} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar networkBadge={networkBadge} walletControl={walletControl} />
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 md:p-6">{children}</main>
        <footer
          aria-label="System status"
          className="border-t border-border bg-surface/90 px-4 py-2 text-xs backdrop-blur"
        >
          <div className="flex flex-wrap gap-x-5 gap-y-1">{statusItems}</div>
        </footer>
      </div>
    </div>
  );
}
