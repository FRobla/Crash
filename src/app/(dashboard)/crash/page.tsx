import type { Metadata } from "next";
import { SOLANA_BET_ASSET_SYMBOLS } from "@/chain-adapters/solana/assets";
import { BetPanel } from "@/games/crash/ui/BetPanel";
import { CrashConsole } from "@/games/crash/ui/CrashConsole";
import { RoundFeed } from "@/games/crash/ui/RoundFeed";

export const metadata: Metadata = { title: "Crash" };

export default function CrashPage() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <h1 className="sr-only">Crash</h1>
      <div className="flex min-w-0 flex-col gap-4">
        <CrashConsole />
        <RoundFeed />
      </div>
      <BetPanel
        assets={SOLANA_BET_ASSET_SYMBOLS}
        unavailableReason="Betting unavailable — round engine not implemented."
      />
    </div>
  );
}
