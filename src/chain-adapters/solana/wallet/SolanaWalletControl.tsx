"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LogOut, Wallet } from "lucide-react";
import { shortenAddress } from "@/platform/wallets/wallet-session";
import { useSolanaWalletSession } from "./use-solana-wallet-session";

const BUTTON_CLASS =
  "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:text-fg";

export function SolanaWalletControl() {
  const session = useSolanaWalletSession();
  const { disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  if (session.status === "connected" && session.address) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-sm"
          title={session.address}
        >
          <Wallet aria-hidden="true" className="size-4 text-accent" />
          <span className="sr-only">Connected wallet </span>
          {shortenAddress(session.address)}
        </span>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label="Disconnect wallet"
          // Adapter errors are already reported through WalletProvider's onError.
          onClick={() => void disconnect().catch(() => undefined)}
        >
          <LogOut aria-hidden="true" className="size-4" />
        </button>
      </div>
    );
  }

  const busy = session.status !== "disconnected";
  return (
    <button
      type="button"
      className={BUTTON_CLASS}
      disabled={busy}
      onClick={() => setVisible(true)}
    >
      <Wallet aria-hidden="true" className="size-4" />
      {busy ? `${session.status}…` : "Connect wallet"}
    </button>
  );
}
