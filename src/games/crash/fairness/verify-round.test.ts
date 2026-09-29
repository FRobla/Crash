import { describe, expect, it } from "vitest";
import devnet from "./fixtures/devnet-rounds.json";
import { computeCommitment, verifyRound, type RoundEvidence } from "./verify-round";

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
