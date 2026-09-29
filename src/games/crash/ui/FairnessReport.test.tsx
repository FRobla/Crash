import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import devnet from "../fairness/fixtures/devnet-rounds.json";
import type { RoundEvidence } from "../fairness/verify-round";
import { FairnessReport } from "./FairnessReport";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

const round3 = devnet.rounds[3];
const evidence: RoundEvidence = {
  programId: fromHex(devnet.programId),
  roundId: 3n,
  rulesVersion: 1,
  outcome: "revealed",
  commit: fromHex(round3.commit),
  seed: fromHex(round3.seed),
  vrfOutput: fromHex(round3.vrfOutput),
  crashPoint: BigInt(round3.crashPoint),
  crashTick: BigInt(round3.crashTick),
};

describe("FairnessReport", () => {
  it("verifies a real devnet round", async () => {
    render(<FairnessReport evidence={evidence} details={[]} />);
    expect(await screen.findByText(/Verified: round #3 crashed at 9\.45x/)).toBeInTheDocument();
    expect(screen.getAllByText("match")).toHaveLength(3);
  });

  it("flags a manipulated result", async () => {
    render(<FairnessReport evidence={{ ...evidence, crashPoint: 20_000n }} details={[]} />);
    expect(await screen.findByText(/Verification FAILED/)).toBeInTheDocument();
    expect(screen.getByText("MISMATCH")).toBeInTheDocument();
  });

  it("says plainly when a round cannot be verified", async () => {
    render(<FairnessReport evidence={{ ...evidence, outcome: "voided" }} details={[{ label: "state", value: "voided" }]} />);
    expect(await screen.findByText(/Voided before it started/)).toBeInTheDocument();
    expect(screen.queryByText(/seed \(revealed\)/)).not.toBeInTheDocument();
  });
});
