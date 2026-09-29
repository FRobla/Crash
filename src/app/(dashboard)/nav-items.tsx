import { History, Landmark, ShieldCheck, TrendingUp } from "lucide-react";
import type { NavItem } from "@/platform/shell/Sidebar";

const ICON_CLASS = "size-4";

export const DASHBOARD_NAV_ITEMS: readonly NavItem[] = [
  { href: "/crash", label: "Crash", icon: <TrendingUp className={ICON_CLASS} />, available: true },
  { href: "/history", label: "History", icon: <History className={ICON_CLASS} />, available: true },
  { href: "/fairness", label: "Fairness", icon: <ShieldCheck className={ICON_CLASS} />, available: true },
  { href: "/bank", label: "Bank", icon: <Landmark className={ICON_CLASS} />, available: false },
];
