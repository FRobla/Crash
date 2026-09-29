"use client";

import { createContext, useContext } from "react";
import type { ActionState } from "@/platform/transactions/action-state";

/**
 * Chain-agnostic player account port (ADR 0003): an on-chain balance in coins, a limited session
 * key for betting and a public username. Chain adapters implement it; the app composes them.
 * Amounts are base units (1 coin = 10⁶).
 */

export type SessionStatus =
  /** Usable for bets on this device. */
  | "active"
  | "expired"
  /** The account has a session, but its key is not on this device. */
  | "other-device"
  /** The session key cannot pay more transaction fees. */
  | "out-of-fees"
  | "none";

export interface PlayerSessionView {
  status: SessionStatus;
  spendCap: bigint;
  spent: bigint;
  /** Estimated from slots; approximate. */
  expiresInSeconds: number | null;
}

export type UsernameCheck = "available" | "taken" | "invalid";

export interface PlayerAccountPort {
  wallet: "disconnected" | "connecting" | "connected";
  status: "loading" | "unregistered" | "registered" | "error";
  username: string | null;
  address: string | null;
  balance: bigint | null;
  /** Base units the wallet itself holds (for the buy form). */
  walletBalance: bigint | null;
  session: PlayerSessionView;
  hasActiveBet: boolean;
  /** One-off costs of registering, in base units (account rent + session fee budget). */
  registrationOverhead: bigint;
  action: ActionState;
  /** Public explorer link for a transaction signature. */
  explorerUrl(signature: string): string;
  checkUsername(username: string): Promise<UsernameCheck>;
  register(username: string, coins: bigint): Promise<void>;
  /** Buys coins and refreshes the session so its spending cap covers the new balance. */
  buy(coins: bigint): Promise<void>;
  renewSession(): Promise<void>;
  revokeSession(): Promise<void>;
  /** Revokes the session, sells the whole balance and returns the session key's fee budget. */
  exit(): Promise<void>;
  /** Test networks only: where to get free test funds, and a best-effort request for some. */
  testFunds?: { faucetUrl: string; request(): Promise<void> };
}

const PlayerAccountContext = createContext<PlayerAccountPort | null>(null);

export const PlayerAccountProvider = PlayerAccountContext.Provider;

export function usePlayerAccount(): PlayerAccountPort {
  const port = useContext(PlayerAccountContext);
  if (!port) throw new Error("usePlayerAccount requires a PlayerAccountProvider");
  return port;
}

/** Same rules as the program (spec v2 §3.3): 3–16 bytes of `[a-z0-9_]`. */
export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_]{3,16}$/.test(username);
}
