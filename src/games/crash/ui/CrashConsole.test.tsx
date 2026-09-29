import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CrashConsole } from "./CrashConsole";
import { CrashGameProvider, type CrashGamePort, type LiveRound } from "./crash-game";

function round(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    roundId: 7n,
    rulesVersion: 1,
    phase: "betting",
    commitHex: "ab".repeat(32),
    bettingEndTick: 1_050n,
    startTick: null,
    crashPoint: null,
    crashTick: null,
    betCount: 2,
    ...overrides,
  };
}

function game(overrides: Partial<CrashGamePort> = {}): CrashGamePort {
  return {
    connection: "live",
    paused: false,
    limits: null,
    round: round(),
    estimatedTick: () => 1_000n,
    myBet: null,
    playerBlocker: null,
    balance: null,
    recentRounds: [],
    action: { status: "idle" },
    explorerUrl: (signature) => signature,
    placeBet: vi.fn(async () => undefined),
    cashOut: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderConsole(port: CrashGamePort) {
  return render(
    <CrashGameProvider value={port}>
      <CrashConsole />
    </CrashGameProvider>,
  );
}

describe("CrashConsole", () => {
  it("shows the betting countdown and marks the current lifecycle step", () => {
    renderConsole(game());
    expect(screen.getByText("Betting open, closes in about 20 seconds")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Betting open");
    expect(screen.getByText("Bets").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/2 bets in round #7/)).toBeInTheDocument();
  });

  it("labels the running multiplier as an estimate", () => {
    renderConsole(game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_030n }));
    expect(screen.getByText("Running, estimated multiplier 2.03x")).toBeInTheDocument();
    expect(screen.getByText(/estimated from the slot clock/)).toBeInTheDocument();
    expect(screen.getByText("Live").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("shows the revealed crash point once the round ends", () => {
    renderConsole(game({ round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }) }));
    expect(screen.getByText("Crashed at 1.50x")).toBeInTheDocument();
    expect(screen.getByText(/revealed on-chain/)).toBeInTheDocument();
  });

  it("flags voided rounds outside the normal lifecycle", () => {
    renderConsole(game({ round: round({ phase: "voided" }) }));
    expect(screen.getByText("Round voided, stakes refunded")).toBeInTheDocument();
    expect(screen.getAllByText("voided").length).toBeGreaterThan(0);
  });
});
