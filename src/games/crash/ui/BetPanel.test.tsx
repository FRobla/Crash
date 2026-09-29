import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BetPanel } from "./BetPanel";
import { CrashGameProvider, type CrashGamePort, type LiveRound } from "./crash-game";

const LIMITS = { minStake: 1_000_000n, maxStake: 2_000_000n, maxPayout: 200_000_000n, maxRoundExposure: 500_000_000n };

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
    betCount: 0,
    ...overrides,
  };
}

function game(overrides: Partial<CrashGamePort> = {}): CrashGamePort {
  return {
    connection: "live",
    paused: false,
    limits: LIMITS,
    round: round(),
    estimatedTick: () => 1_000n,
    myBet: null,
    playerBlocker: null,
    balance: 10_000_000n,
    recentRounds: [],
    action: { status: "idle" },
    explorerUrl: (signature) => `https://explorer.example/${signature}`,
    placeBet: vi.fn(async () => undefined),
    cashOut: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPanel(port: CrashGamePort) {
  return render(
    <CrashGameProvider value={port}>
      <BetPanel />
    </CrashGameProvider>,
  );
}

describe("BetPanel", () => {
  it("disables placing a bet and explains why when the player cannot bet", () => {
    renderPanel(game({ playerBlocker: "Connect a wallet to bet." }));
    const placeBet = screen.getByRole("button", { name: "Place bet" });
    expect(placeBet).toBeDisabled();
    expect(placeBet).toHaveAccessibleDescription("Connect a wallet to bet.");
  });

  it("places a bet in base units with the auto cash-out in ten-thousandths", async () => {
    const port = game();
    renderPanel(port);
    await userEvent.clear(screen.getByLabelText("Stake (coins)"));
    await userEvent.type(screen.getByLabelText("Stake (coins)"), "1.5");
    await userEvent.type(screen.getByLabelText("Auto cash-out (multiplier)"), "2.25");
    await userEvent.click(screen.getByRole("button", { name: "Place bet" }));
    expect(port.placeBet).toHaveBeenCalledWith(1_500_000n, 22_500n);
  });

  it("rejects stakes outside the house limits before signing", async () => {
    renderPanel(game());
    await userEvent.clear(screen.getByLabelText("Stake (coins)"));
    await userEvent.type(screen.getByLabelText("Stake (coins)"), "5");
    expect(screen.getByRole("button", { name: "Place bet" })).toHaveAccessibleDescription("Stake is above the maximum.");
  });

  it("does not offer betting once the window has closed", () => {
    renderPanel(game({ estimatedTick: () => 1_050n }));
    expect(screen.getByRole("button", { name: "Place bet" })).toHaveAccessibleDescription("Betting is closing.");
  });

  it("offers a cash-out with the projected multiplier while the round runs", async () => {
    const port = game({
      round: round({ phase: "running", startTick: 1_000n }),
      estimatedTick: () => 1_030n,
      myBet: { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: null },
    });
    renderPanel(port);
    const button = screen.getByRole("button", { name: /Cash out ~2\.03x/ });
    await userEvent.click(button);
    expect(port.cashOut).toHaveBeenCalled();
  });

  it("stops offering a manual cash-out once the auto cash-out target is reached", () => {
    renderPanel(
      game({
        round: round({ phase: "running", startTick: 1_000n }),
        estimatedTick: () => 1_030n,
        myBet: { roundId: 7n, stake: 1_000_000n, autoCashOut: 20_000n, exposure: 2_000_000n, cashOutTick: null },
      }),
    );
    expect(screen.queryByRole("button", { name: /Cash out/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Auto 2\.00x reached \(estimated\)/)).toBeInTheDocument();
  });

  it("shows the rule-based outcome of a finished bet as pending settlement", () => {
    renderPanel(
      game({
        round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }),
        myBet: { roundId: 7n, stake: 1_000_000n, autoCashOut: 20_000n, exposure: 2_000_000n, cashOutTick: null },
      }),
    );
    expect(screen.getByText("lost")).toBeInTheDocument();
    expect(screen.getByText(/pending settlement/)).toBeInTheDocument();
  });
});
