import type { Metadata } from "next";
import { CrashConsole } from "@/games/crash/ui/CrashConsole";
import { BetPanel } from "@/games/crash/ui/BetPanel";
import { PlayerPanel } from "@/platform/player-accounts/PlayerPanel";
import { RecentRounds } from "./recent-rounds";

export const metadata: Metadata = { title: "Crash" };

/** On small screens the bet panel follows the live round directly, before history and account. */
export default function CrashPage() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr]">
      <h1 className="sr-only">Crash</h1>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <CrashConsole />
      </div>
      <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <div className="flex flex-col gap-4">
          <BetPanel />
          <PlayerPanel />
        </div>
      </div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-2">
        <RecentRounds />
      </div>
    </div>
  );
}
