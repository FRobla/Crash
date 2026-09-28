"use client";

import "@solana/wallet-adapter-react-ui/styles.css";
import type { ConnectionConfig } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { ReactNode } from "react";
import { solanaConfig } from "../config";
import { RpcHealthProvider } from "../network/RpcHealthProvider";

// Hoisted so the providers keep a stable Connection across renders.
const CONNECTION_CONFIG: ConnectionConfig = { commitment: "confirmed" };
// Wallets are discovered through the Wallet Standard (Phantom, Solflare, Backpack, ...),
// so no per-wallet adapter packages are bundled.
const WALLET_ADAPTERS: [] = [];

/**
 * Read-only wallet connection on devnet: no signing or transactions are wired yet.
 * autoConnect stays off until wallet sessions have a spec.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={solanaConfig.rpcUrl} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={WALLET_ADAPTERS} autoConnect={false}>
        <WalletModalProvider>
          <RpcHealthProvider>{children}</RpcHealthProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
