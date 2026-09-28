import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNavItemActive, Sidebar, type NavItem } from "./Sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/crash",
}));

const ITEMS: NavItem[] = [
  { href: "/crash", label: "Crash", icon: null, available: true },
  { href: "/history", label: "History", icon: null, available: false },
];

describe("Sidebar", () => {
  it("marks only the current route as the active page", () => {
    render(<Sidebar brand="[TEST]" items={ITEMS} />);

    expect(screen.getByRole("link", { name: "Crash" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /History/ })).not.toHaveAttribute("aria-current");
  });

  it("tags sections that are not implemented yet", () => {
    render(<Sidebar brand="[TEST]" items={ITEMS} />);

    expect(screen.getByRole("link", { name: /History/ })).toHaveTextContent("soon");
    expect(screen.getByRole("link", { name: "Crash" })).not.toHaveTextContent("soon");
  });
});

describe("isNavItemActive", () => {
  it("matches nested routes but not sibling prefixes", () => {
    expect(isNavItemActive("/crash/rounds/1", "/crash")).toBe(true);
    expect(isNavItemActive("/crashes", "/crash")).toBe(false);
  });
});
