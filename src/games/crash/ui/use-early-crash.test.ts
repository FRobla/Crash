import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import devnet from "../fairness/fixtures/devnet-rounds.json";
import type { LiveRound } from "./crash-game";
import { applyEarlyCrash, cashOutOffer, myBetOutcome, roundDisplay } from "./round-view";
import { useEarlyCrash } from "./use-early-crash";

const revealed = devnet.rounds.filter((round) => round.phase === "Settled" || round.phase === "Crashed");
const [fixture, other] = revealed;

function running(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    roundId: BigInt(fixture.roundId),
    rulesVersion: fixture.rulesVersion,
    phase: "running",
    commitHex: fixture.commit,
    openedTick: 900n,
    bettingEndTick: 966n,
    startTick: 1_000n,
    vrfOutputHex: fixture.vrfOutput,
    crashPoint: null,
    crashTick: null,
    betCount: 1,
    ...overrides,
  };
}

function port(round: LiveRound | null, seedHex: string, roundId = round?.roundId ?? 0n) {
  return { round, revealHint: { roundId, seedHex }, programIdHex: devnet.programId };
}

describe("useEarlyCrash", () => {
  it("accepts a seed that reproduces the on-chain commit and derives the round's real crash", async () => {
    const { result } = renderHook(() => useEarlyCrash(port(running(), fixture.seed)));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({
      roundId: BigInt(fixture.roundId),
      crashPoint: BigInt(fixture.crashPoint),
      crashTick: BigInt(fixture.crashTick),
    });
  });

  it("ignores a foreign seed, a hint for another round, a missing VRF output or a malformed seed", async () => {
    const cases = [
      port(running(), other.seed),
      port(running(), fixture.seed, BigInt(fixture.roundId) + 1n),
      port(running({ vrfOutputHex: null }), fixture.seed),
      port(running(), fixture.seed.toUpperCase()),
      port(running({ commitHex: other.commit }), fixture.seed),
    ];
    for (const game of cases) {
      const { result } = renderHook(() => useEarlyCrash(game));
      // Give the verification a chance to finish before asserting nothing was accepted.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.current).toBeNull();
    }
  });
});

describe("provisional crash", () => {
  const early = { roundId: 7n, crashPoint: 15_000n, crashTick: 18n };
  const round = running({ roundId: 7n, startTick: 1_000n });
  const myBet = { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 1_000_000n, cashOutTick: null };

  it("turns a running round into a provisional crash, and never overrides an on-chain result", () => {
    const shown = applyEarlyCrash(round, early);
    expect(shown).toMatchObject({ phase: "crashed", crashPoint: 15_000n, provisional: true });
    expect(roundDisplay(shown, 1_020, 230)).toEqual({ kind: "crashed", crashPoint: 15_000n, provisional: true });
    const forfeited = { ...round, phase: "forfeited" as const };
    expect(applyEarlyCrash(forfeited, early)).toBe(forfeited);
    expect(applyEarlyCrash(round, { ...early, roundId: 8n })).toBe(round);
    expect(applyEarlyCrash(round, null)).toBe(round);
  });

  it("stops offering a cash-out from the verified crash on", () => {
    expect(cashOutOffer(round, myBet, 1_010n)).not.toBeNull();
    expect(cashOutOffer(applyEarlyCrash(round, early), myBet, 1_010n)).toBeNull();
  });

  it("settles the auto cash-out by the rules against the verified crash, pending settlement", () => {
    const shown = applyEarlyCrash(round, early);
    expect(myBetOutcome(shown, { ...myBet, autoCashOut: 15_000n })).toMatchObject({ kind: "cashed-out", multiplier: 15_000n });
    expect(myBetOutcome(shown, { ...myBet, autoCashOut: 15_100n })).toEqual({ kind: "lost" });
    expect(myBetOutcome(shown, myBet)).toEqual({ kind: "lost" });
  });
});
