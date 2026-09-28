"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** False for sections that exist in the navigation but are not implemented yet. */
  available: boolean;
}

interface SidebarProps {
  brand: string;
  items: readonly NavItem[];
}

export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ brand, items }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="border-b border-border bg-surface md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center gap-4 px-4 py-3 md:flex-col md:items-stretch md:gap-6 md:py-4">
        <Link href="/" className="shrink-0 font-semibold tracking-wide text-accent">
          {brand}
        </Link>
        <nav aria-label="Main" className="min-w-0 overflow-x-auto">
          <ul className="flex gap-1 md:flex-col">
            {items.map((item) => {
              const active = isNavItemActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2 border px-2 py-1.5 text-sm whitespace-nowrap transition-colors ${
                      active
                        ? "border-border bg-surface-raised text-fg"
                        : "border-transparent text-muted hover:text-fg"
                    }`}
                  >
                    <span aria-hidden="true" className={active ? "text-accent" : undefined}>
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                    {!item.available && (
                      <span className="ml-auto border border-border px-1 text-[10px] uppercase text-muted">
                        soon
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
