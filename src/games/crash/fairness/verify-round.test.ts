import { describe, expect, it } from "vitest";
import devnet from "./fixtures/devnet-rounds.json";
import { computeCommitment, deriveOutcome, toHex, verifyRound, type RoundEvidence } from "./verify-round";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

const OUTCOMES: Record<string, RoundEvidence["outcome"]> = {
  Crashed: "revealed",
  Settled: "revealed",
  Voided: "voided",
  Forfeited: "forfeited",
};

function evidence(round: (typeof devnet.rounds)[number]): RoundEvidence {
  return {
    programId: fromHex(devnet.programId),
    roundId: BigInt(round.roundId),
    rulesVersion: round.rulesVersion,
    outcome: OUTCOMES[round.phase] ?? "pending",
    commit: fromHex(round.commit),
    seed: fromHex(round.seed),
    vrfOutput: fromHex(round.vrfOutput),
    crashPoint: BigInt(round.crashPoint),
    crashTick: BigInt(round.crashTick),
  };
}

const revealed = devnet.rounds.filter((round) => OUTCOMES[round.phase] === "revealed");

describe("verifyRound", () => {
  it("reproduces every revealed devnet round settled by the on-chain program", async () => {
    expect(revealed.length).toBeGreaterThanOrEqual(3);
    for (const round of revealed) {
      const result = await verifyRound(evidence(round));
      expect(result.status, `round ${round.roundId}`).toBe("verified");
    }
  });

  it("detects a seed that does not match the commitment", async () => {
    const tampered = evidence(revealed[0]);
    tampered.seed = tampered.seed.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
    const result = await verifyRound(tampered);
    expect(result.status).toBe("mismatch");
    if (result.status !== "unverifiable") {
      expect(result.checks.find((check) => check.name === "commitment")?.ok).toBe(false);
    }
  });

  it("detects a recorded crash point that the entropy does not produce", async () => {
    const tampered = { ...evidence(revealed[0]), crashPoint: BigInt(revealed[0].crashPoint) + 100n };
    const result = await verifyRound(tampered);
    expect(result.status).toBe("mismatch");
    if (result.status !== "unverifiable") {
      expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
        ["commitment", true],
        ["crash-point", false],
        ["crash-tick", true],
      ]);
    }
  });

  it("does not claim to verify voided, forfeited, pending, unknown-rules or malformed rounds", async () => {
    const voided = devnet.rounds.find((round) => round.phase === "Voided")!;
    expect(await verifyRound(evidence(voided))).toEqual({ status: "unverifiable", reason: "voided" });
    const base = evidence(revealed[0]);
    expect(await verifyRound({ ...base, outcome: "forfeited" })).toEqual({ status: "unverifiable", reason: "forfeited" });
    expect(await verifyRound({ ...base, outcome: "pending" })).toEqual({ status: "unverifiable", reason: "pending" });
    expect(await verifyRound({ ...base, rulesVersion: 9 })).toEqual({ status: "unverifiable", reason: "unknown-rules" });
    expect(await verifyRound({ ...base, seed: new Uint8Array(31) })).toEqual({ status: "unverifiable", reason: "malformed" });
  });

  it("derives each revealed devnet round's commit, crash point and tick from its seed and VRF output", async () => {
    for (const round of revealed) {
      const base = evidence(round);
      const outcome = await deriveOutcome(base.programId, base.roundId, base.rulesVersion, base.seed, base.vrfOutput);
      expect(outcome, `round ${round.roundId}`).not.toBeNull();
      expect(toHex(outcome!.commitment)).toBe(round.commit);
      expect(outcome!.crashPoint).toBe(base.crashPoint);
      expect(outcome!.crashTick).toBe(base.crashTick);
    }
  });

  it("does not reproduce the commit or crash for a foreign seed, round or VRF output", async () => {
    const [first, second] = revealed.map(evidence);
    const derive = (e: RoundEvidence) => deriveOutcome(e.programId, e.roundId, e.rulesVersion, e.seed, e.vrfOutput);
    const foreignSeed = await derive({ ...first, seed: second.seed });
    const foreignRound = await derive({ ...first, roundId: second.roundId });
    const foreignVrf = await derive({ ...first, vrfOutput: second.vrfOutput });
    expect(toHex(foreignSeed!.commitment)).not.toBe(toHex(first.commit));
    expect(toHex(foreignRound!.commitment)).not.toBe(toHex(first.commit));
    // Same seed, so the commit still matches: only the entropy (and so the crash) changes.
    expect(toHex(foreignVrf!.commitment)).toBe(toHex(first.commit));
    expect(foreignVrf!.entropy).not.toEqual((await derive(first))!.entropy);
    expect(await derive({ ...first, rulesVersion: 9 })).toBeNull();
    expect(await derive({ ...first, vrfOutput: new Uint8Array(31) })).toBeNull();
  });

  it("binds the commitment to the program and the round id", async () => {
    const base = evidence(revealed[0]);
    const commit = await computeCommitment(base.programId, base.roundId, base.seed);
    const otherRound = await computeCommitment(base.programId, base.roundId + 1n, base.seed);
    const otherProgram = await computeCommitment(new Uint8Array(32), base.roundId, base.seed);
    expect(commit).toEqual(base.commit);
    expect(otherRound).not.toEqual(commit);
    expect(otherProgram).not.toEqual(commit);
  });
});
