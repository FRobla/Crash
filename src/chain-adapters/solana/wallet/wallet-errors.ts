"use client";

import { useSyncExternalStore } from "react";

/**
 * Last wallet adapter error, shown next to the connect button. A tiny external store so the
 * provider's `onError` (outside the control's tree position) can report to it.
 */

let current: string | null = null;
const listeners = new Set<() => void>();

const FRIENDLY: Record<string, string> = {
  WalletNotReadyError: "Wallet not installed or not ready. Install Phantom, Solflare or Backpack, then reload.",
  WalletConnectionError: "The wallet refused the connection. Unlock it and try again.",
  WalletWindowClosedError: "The wallet window was closed before connecting.",
  WalletTimeoutError: "The wallet did not answer in time. Try again.",
  WalletDisconnectedError: "The wallet disconnected.",
};

export function describeWalletError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (FRIENDLY[name]) return FRIENDLY[name];
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|rejected the request/i.test(message)) return "Connection cancelled in the wallet.";
  return `Wallet error: ${message.split("\n")[0].slice(0, 120) || name || "unknown"}`;
}

export function reportWalletError(error: unknown): void {
  current = describeWalletError(error);
  listeners.forEach((listener) => listener());
}

export function clearWalletError(): void {
  if (current === null) return;
  current = null;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWalletError(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
