"use client";

import type { ReactNode } from "react";
import { useSolanaCrash } from "@/chain-adapters/solana/crash-program/use-solana-crash";
import { CrashGameProvider, type CrashGamePort } from "@/games/crash/ui/crash-game";
import { PlayerAccountProvider, type PlayerAccountPort } from "@/platform/player-accounts/player-account";

/**
 * Composition root of the live game: the Solana adapter implements the chain-agnostic game and
 * player-account ports. The explicit port types make the compiler check the adapter's shape.
 */
export function CrashRuntime({ children }: { children: ReactNode }) {
  const { game, account } = useSolanaCrash();
  const gamePort: CrashGamePort = game;
  const accountPort: PlayerAccountPort = account;
  return (
    <CrashGameProvider value={gamePort}>
      <PlayerAccountProvider value={accountPort}>{children}</PlayerAccountProvider>
    </CrashGameProvider>
  );
}
