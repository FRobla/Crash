import type { Metadata } from "next";
import { CrashConsole } from "@/games/crash/ui/CrashConsole";
import { BetPanel } from "@/games/crash/ui/BetPanel";
import { PlayerPanel } from "@/platform/player-accounts/PlayerPanel";
import { RecentRounds } from "./recent-rounds";

export const metadata: Metadata = { title: "Crash" };

export default function CrashPage() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <h1 className="sr-only">Crash</h1>
      <div className="flex min-w-0 flex-col gap-4">
        <CrashConsole />
        <RecentRounds />
      </div>
      <div className="flex flex-col gap-4 lg:self-start">
        <BetPanel />
        <PlayerPanel />
      </div>
    </div>
  );
}
