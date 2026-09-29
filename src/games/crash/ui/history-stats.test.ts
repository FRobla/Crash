import { describe, expect, it } from "vitest";
import { crashPointStats, summarizeBets } from "./history-stats";

describe("crashPointStats", () => {
  it("summarizes revealed rounds only, with a median that actually happened", () => {
    const stats = crashPointStats([
      { phase: "settled", crashPoint: 15_000n },
      { phase: "crashed", crashPoint: 30_000n },
      { phase: "voided", crashPoint: null },
      { phase: "settled", crashPoint: 20_000n },
      { phase: "settled", crashPoint: 10_000n },
      { phase: "running", crashPoint: null },
    ]);
    expect(stats).toEqual({ revealed: 4, atLeastTwo: 2, median: 15_000n, highest: 30_000n });
  });

  it("is empty without revealed rounds", () => {
    expect(crashPointStats([{ phase: "forfeited", crashPoint: null }])).toEqual({
      revealed: 0,
      atLeastTwo: 0,
      median: null,
      highest: null,
    });
  });
});

describe("summarizeBets", () => {
  it("adds stakes and payouts exactly in base units", () => {
    const summary = summarizeBets([
      { stake: 1_000_000n, payout: 2_030_000n, outcome: "cashed-out" },
      { stake: 1_500_000n, payout: 0n, outcome: "lost" },
      { stake: 1_000_000n, payout: 1_000_000n, outcome: "refunded" },
    ]);
    expect(summary).toEqual({
      count: 3,
      won: 1,
      lost: 1,
      refunded: 1,
      staked: 3_500_000n,
      paidOut: 3_030_000n,
      net: -470_000n,
    });
  });
});
