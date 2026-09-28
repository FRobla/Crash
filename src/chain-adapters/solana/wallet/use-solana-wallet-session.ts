"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletSession, WalletSessionStatus } from "@/platform/wallets/wallet-session";

/** Maps the Solana wallet adapter state to the chain-agnostic WalletSession port. */
export function useSolanaWalletSession(): WalletSession {
  const { publicKey, connected, connecting, disconnecting, wallet } = useWallet();

  let status: WalletSessionStatus = "disconnected";
  if (connecting) status = "connecting";
  else if (disconnecting) status = "disconnecting";
  else if (connected && publicKey) status = "connected";

  return {
    status,
    address: status === "connected" && publicKey ? publicKey.toBase58() : null,
    walletName: wallet?.adapter.name ?? null,
  };
}
