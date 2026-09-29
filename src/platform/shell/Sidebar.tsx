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
    <aside className="border-b border-border bg-surface/90 backdrop-blur md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center gap-4 px-4 py-3 md:flex-col md:items-stretch md:gap-6 md:py-5">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-wide text-accent">
          <BrandMark />
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
                    className={`group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors ${
                      active ? "bg-surface-raised text-fg" : "text-muted hover:bg-surface-raised/60 hover:text-fg"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-accent transition-opacity md:block ${
                        active ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <span
                      aria-hidden="true"
                      className={`transition-colors ${active ? "text-accent" : "group-hover:text-fg"}`}
                    >
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                    {!item.available && (
                      <span className="ml-auto rounded border border-border px-1 text-[10px] uppercase text-muted">
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

/** Decorative logo: a rising curve on a baseline. */
function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="none">
      <rect x="0.75" y="0.75" width="18.5" height="18.5" rx="4" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d="M4 15.5 C 9 15, 12 12, 15.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="15.5" cy="4.5" r="1.8" fill="currentColor" />
    </svg>
  );
}
