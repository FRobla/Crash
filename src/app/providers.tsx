import type { ReactNode } from "react";
import { SolanaWalletProvider } from "@/chain-adapters/solana/wallet/SolanaWalletProvider";

/** Composition root for client-side providers. Chain adapters are wired here, not in games. */
export function Providers({ children }: { children: ReactNode }) {
  return <SolanaWalletProvider>{children}</SolanaWalletProvider>;
}
