import { describe, expect, it } from "vitest";
import type { LiveRound } from "./crash-game";
import {
  DEFAULT_LAG_TICKS,
  LAG_SAMPLE_WINDOW,
  MAX_LAG_TICKS,
  MIN_LAG_TICKS,
  PresentationLag,
  playoutRound,
  presentedTick,
} from "./presentation-lag";

function crashedRound(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    roundId: 7n,
    rulesVersion: 1,
    phase: "crashed",
    commitHex: "ab".repeat(32),
    openedTick: 900n,
    bettingEndTick: 966n,
    startTick: 1_000n,
    vrfOutputHex: null,
    crashPoint: 10_000n,
    crashTick: 0n,
    betCount: 1,
    ...overrides,
  };
}

describe("PresentationLag", () => {
  it("starts at the default lag and then covers the slowest recent crash, rounded up", () => {
    const lag = new PresentationLag();
    expect(lag.current()).toBe(DEFAULT_LAG_TICKS);
    lag.record(1n, 2.2);
    lag.record(2n, 4.1);
    lag.record(3n, 3);
    expect(lag.current()).toBe(5);
  });

  it("stays within its bounds", () => {
    const fast = new PresentationLag();
    fast.record(1n, 0);
    expect(fast.current()).toBe(MIN_LAG_TICKS);
    const slow = new PresentationLag();
    slow.record(1n, 500);
    expect(slow.current()).toBe(MAX_LAG_TICKS);
  });

  it("counts each round once and forgets samples outside its window", () => {
    const lag = new PresentationLag();
    lag.record(1n, 9);
    lag.record(1n, 2);
    expect(lag.current()).toBe(9);
    for (let id = 2; id < 2 + LAG_SAMPLE_WINDOW; id++) lag.record(BigInt(id), 2);
    expect(lag.current()).toBe(2);
  });

  it("fixes a round's lag at its first use, so a new sample never moves a round being shown", () => {
    const lag = new PresentationLag();
    expect(lag.forRound(5n)).toBe(DEFAULT_LAG_TICKS);
    lag.record(4n, 12);
    expect(lag.forRound(5n)).toBe(DEFAULT_LAG_TICKS);
    expect(lag.forRound(6n)).toBe(12);
  });
});

describe("playoutRound", () => {
  it("shows a 1.00x crash learned within the lag at once: the lagged curve never left 1.00x", () => {
    const round = crashedRound();
    expect(presentedTick(1_000n, 1_003, 4)).toBe(0);
    expect(playoutRound(round, 1_003, 4, true)).toBe(round);
  });

  it("plays out a later crash up to its crash tick, then shows it", () => {
    const round = crashedRound({ crashPoint: 15_000n, crashTick: 18n });
    expect(playoutRound(round, 1_021.9, 4, true)?.phase).toBe("running");
    expect(playoutRound(round, 1_022, 4, true)).toBe(round);
  });

  it("does not play out rounds it never saw running, nor anything but a known crash", () => {
    const round = crashedRound();
    expect(playoutRound(round, 1_001, 4, false)).toBe(round);
    const voided = crashedRound({ phase: "voided", crashPoint: null, crashTick: null });
    expect(playoutRound(voided, 1_001, 4, true)).toBe(voided);
    const running = crashedRound({ phase: "running", crashPoint: null, crashTick: null });
    expect(playoutRound(running, 1_001, 4, true)).toBe(running);
  });
});
