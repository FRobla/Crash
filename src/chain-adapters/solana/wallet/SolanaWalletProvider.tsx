"use client";

import "@solana/wallet-adapter-react-ui/styles.css";
import type { ConnectionConfig } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { ReactNode } from "react";
import { solanaConfig } from "../config";
import { RpcHealthProvider } from "../network/RpcHealthProvider";
import { reportWalletError } from "./wallet-errors";

// Hoisted so the providers keep a stable Connection across renders.
const CONNECTION_CONFIG: ConnectionConfig = { commitment: "confirmed" };
// Wallets are discovered through the Wallet Standard (Phantom, Solflare, Backpack, ...),
// so no per-wallet adapter packages are bundled.
const WALLET_ADAPTERS: [] = [];

/**
 * Devnet wallet connection. `autoConnect` makes the provider connect as soon as a wallet is
 * picked in the modal (the modal itself only selects it) and reconnect on reload. Signing only
 * happens in the flows of spec crash-client-v1 §6.2. Adapter errors are shown by the control.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={solanaConfig.rpcUrl} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={WALLET_ADAPTERS} autoConnect onError={reportWalletError}>
        <WalletModalProvider>
          <RpcHealthProvider>{children}</RpcHealthProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
