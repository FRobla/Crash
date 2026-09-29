// @vitest-environment node
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { HouseConfigAccount, RoundAccount, RoundPhase } from "@/chain-adapters/solana/crash-program/accounts";
import { planNextAction, type CrankState } from "./plan";

const KEY = PublicKey.default;

function config(overrides: Partial<HouseConfigAccount> = {}): HouseConfigAccount {
  return {
    admin: KEY,
    operator: KEY,
    rulesVersion: 1,
    limits: { minStake: 1n, maxStake: 2n, maxPayout: 3n, maxRoundExposure: 4n },
    maxBetsPerRound: 256,
    timeouts: { bettingSlots: 50n, entropyTimeoutSlots: 300n, revealGraceSlots: 150n },
    playerPolicy: { maxSessionSlots: 1n, usernameCooldownSlots: 1n },
    paused: false,
    nextRoundId: 8n,
    currentRound: 7n,
    randomnessAccount: KEY,
    bump: 0,
    vaultBump: 0,
    randomnessAuthorityBump: 0,
    ...overrides,
  };
}

function round(phase: RoundPhase, overrides: Partial<RoundAccount> = {}): RoundAccount {
  return {
    roundId: 7n,
    rulesVersion: 1,
    phase,
    commit: new Uint8Array(32),
    openedSlot: 1_000n,
    bettingEndSlot: 1_050n,
    entropyDeadlineSlot: 1_400n,
    randomnessAccount: KEY,
    randomnessSeedSlot: 1_049n,
    startSlot: 1_100n,
    revealDeadlineSlot: 1_445n,
    vrfOutput: new Uint8Array(32),
    seed: new Uint8Array(32),
    crashPoint: 0n,
    crashTick: 0n,
    totalExposure: 0n,
    betCount: 1,
    settledCount: 0,
    bump: 0,
    ...overrides,
  };
}

function plan(state: Partial<CrankState> & Pick<CrankState, "round">) {
  return planNextAction({ config: config(), slot: 1_000n, hasSeed: true, crashTick: null, ...state });
}

describe("planNextAction", () => {
  it("opens the next round when none is active, unless paused", () => {
    expect(plan({ config: config({ currentRound: null }), round: null })).toEqual({ kind: "open", roundId: 8n });
    expect(plan({ config: config({ currentRound: null, paused: true }), round: null }).kind).toBe("wait");
  });

  it("waits for the current round account before acting on it", () => {
    expect(plan({ round: null }).kind).toBe("wait");
    expect(plan({ round: round("Betting", { roundId: 6n }) }).kind).toBe("wait");
  });

  describe("Betting", () => {
    it("waits for the window, then closes betting until the commit timeout", () => {
      expect(plan({ round: round("Betting"), slot: 1_049n })).toMatchObject({ kind: "wait", untilSlot: 1_050n });
      expect(plan({ round: round("Betting"), slot: 1_050n })).toEqual({ kind: "close-betting", roundId: 7n });
      expect(plan({ round: round("Betting"), slot: 1_350n })).toEqual({ kind: "close-betting", roundId: 7n });
      expect(plan({ round: round("Betting"), slot: 1_351n })).toEqual({ kind: "void", roundId: 7n, reason: "commit-timeout" });
    });

    it("voids at once when the seed is missing: nobody can know the outcome yet", () => {
      expect(plan({ round: round("Betting"), hasSeed: false })).toEqual({ kind: "void", roundId: 7n, reason: "missing-seed" });
    });
  });

  describe("AwaitingEntropy", () => {
    it("starts until the entropy deadline, then voids", () => {
      expect(plan({ round: round("AwaitingEntropy"), slot: 1_400n })).toEqual({ kind: "start", roundId: 7n });
      expect(plan({ round: round("AwaitingEntropy"), slot: 1_401n })).toEqual({
        kind: "void",
        roundId: 7n,
        reason: "entropy-timeout",
      });
    });

    it("never starts a round it cannot reveal", () => {
      expect(plan({ round: round("AwaitingEntropy"), hasSeed: false, slot: 1_200n })).toMatchObject({
        kind: "wait",
        untilSlot: 1_401n,
      });
      expect(plan({ round: round("AwaitingEntropy"), hasSeed: false, slot: 1_401n }).kind).toBe("void");
    });
  });

  describe("Running", () => {
    it("reveals exactly once the curve reaches the crash tick", () => {
      const running = round("Running");
      expect(plan({ round: running, crashTick: 40n, slot: 1_139n })).toMatchObject({ kind: "wait", untilSlot: 1_140n });
      expect(plan({ round: running, crashTick: 40n, slot: 1_140n })).toEqual({ kind: "reveal", roundId: 7n });
      expect(plan({ round: running, crashTick: 40n, slot: 1_445n })).toEqual({ kind: "reveal", roundId: 7n });
    });

    it("forfeits after the reveal deadline, with or without the seed", () => {
      expect(plan({ round: round("Running"), crashTick: 40n, slot: 1_446n })).toEqual({ kind: "forfeit", roundId: 7n });
      expect(plan({ round: round("Running"), hasSeed: false, slot: 1_200n })).toMatchObject({ kind: "wait", untilSlot: 1_446n });
      expect(plan({ round: round("Running"), hasSeed: false, slot: 1_446n })).toEqual({ kind: "forfeit", roundId: 7n });
    });
  });

  it("does not act on a terminal current round", () => {
    for (const phase of ["Crashed", "Settled", "Voided", "Forfeited"] as const) {
      expect(plan({ round: round(phase) }).kind).toBe("wait");
    }
  });
});
