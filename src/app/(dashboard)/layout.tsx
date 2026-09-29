import type { ReactNode } from "react";
import { SolanaNetworkBadge } from "@/chain-adapters/solana/network/SolanaNetworkBadge";
import { SolanaStatusItems } from "@/chain-adapters/solana/SolanaStatusItems";
import { SolanaWalletControl } from "@/chain-adapters/solana/wallet/SolanaWalletControl";
import { PRODUCT_NAME } from "@/platform/product";
import { DashboardShell } from "@/platform/shell/DashboardShell";
import { CrashRuntime } from "./crash-runtime";
import { DASHBOARD_NAV_ITEMS } from "./nav-items";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardShell
      brand={PRODUCT_NAME}
      navItems={DASHBOARD_NAV_ITEMS}
      networkBadge={<SolanaNetworkBadge />}
      walletControl={<SolanaWalletControl />}
      statusItems={<SolanaStatusItems />}
    >
      <CrashRuntime>{children}</CrashRuntime>
    </DashboardShell>
  );
}
