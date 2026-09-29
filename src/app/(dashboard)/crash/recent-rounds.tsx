"use client";

import { RoundFeed } from "@/games/crash/ui/RoundFeed";

/** Wires the feed's verify links to this app's Fairness route. */
export function RecentRounds() {
  return <RoundFeed verifyHref={(roundId) => `/fairness?round=${roundId}`} />;
}
