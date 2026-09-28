/**
 * Chain-agnostic view of the user's wallet connection. Chain adapters map their
 * wallet state to this shape so platform and game UI never depend on a specific chain.
 */
export type WalletSessionStatus = "disconnected" | "connecting" | "connected" | "disconnecting";

export interface WalletSession {
  status: WalletSessionStatus;
  /** Public address; only present while connected. */
  address: string | null;
  walletName: string | null;
}

export function shortenAddress(address: string, visibleChars = 4): string {
  if (address.length <= visibleChars * 2 + 1) {
    return address;
  }
  return `${address.slice(0, visibleChars)}…${address.slice(-visibleChars)}`;
}
