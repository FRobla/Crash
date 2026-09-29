import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import devnet from "../fairness/fixtures/devnet-rounds.json";
import { BetPanel } from "./BetPanel";
import { CRASH_RULES_V1 } from "../domain/rules";
import { CrashGameProvider, type CrashGamePort, type LiveRound } from "./crash-game";
import { shownMultiplier } from "./live-intensity";
import { presentationLag } from "./presentation-lag";
import { formatMultiplier } from "./multiplier-text";
import { multiplierAt } from "./round-view";

const LIMITS = { minStake: 1_000_000n, maxStake: 2_000_000n, maxPayout: 200_000_000n, maxRoundExposure: 500_000_000n };

function round(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    roundId: 7n,
    rulesVersion: 1,
    phase: "betting",
    commitHex: "ab".repeat(32),
    openedTick: 1_000n,
    bettingEndTick: 1_050n,
    startTick: null,
    vrfOutputHex: null,
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
    projectedTick: () => Number(overrides.estimatedTick?.() ?? 1_000n),
    msPerTick: () => 400,
    revealHint: null,
    liveFeed: "off",
    programIdHex: "00".repeat(32),
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

function ui(port: CrashGamePort) {
  return (
    <CrashGameProvider value={port}>
      <BetPanel />
    </CrashGameProvider>
  );
}

function renderPanel(port: CrashGamePort) {
  return render(ui(port));
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

  it("offers a cash-out showing the headline's multiplier while the round runs", async () => {
    const running = round({ phase: "running", startTick: 1_000n });
    const port = game({
      round: running,
      estimatedTick: () => 1_030n,
      myBet: { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: null },
    });
    renderPanel(port);
    // The same value as the headline: the round's presentation lag behind the projection.
    const lag = presentationLag.forRound(running.roundId);
    const shown = formatMultiplier(shownMultiplier(running, 1_030, false, lag));
    expect(shown).toBe(formatMultiplier(multiplierAt(CRASH_RULES_V1, BigInt(30 - lag))));
    const button = screen.getByRole("button", { name: new RegExp(`Cash out ~${shown.replace(".", "\\.")}`) });
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

  it("queues one bet for the next round and places it once betting opens, after a fresh check", async () => {
    const placeBet = vi.fn(async () => undefined);
    const running = game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_010n, placeBet });
    const { rerender } = render(ui(running));
    await userEvent.type(screen.getByLabelText("Auto cash-out (multiplier)"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Bet next round" }));
    expect(screen.getByRole("region", { name: "Queued bet" })).toHaveTextContent("1.00 coins · auto 2.00x");
    expect(screen.getByRole("button", { name: "Bet next round" })).toBeDisabled();
    expect(placeBet).not.toHaveBeenCalled();

    // Still the same round (now crashed): nothing is sent.
    rerender(ui({ ...running, round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }) }));
    expect(placeBet).not.toHaveBeenCalled();
    // The next round opens: the queued bet goes out once.
    rerender(ui({ ...running, round: round({ roundId: 8n, openedTick: 1_100n, bettingEndTick: 1_166n }), estimatedTick: () => 1_101n }));
    await vi.waitFor(() => expect(placeBet).toHaveBeenCalledWith(1_000_000n, 20_000n));
    expect(placeBet).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Queued bet" })).not.toBeInTheDocument();
  });

  it("drops a queued bet when the session stops being usable, and lets the player cancel it", async () => {
    const running = game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_010n });
    const { rerender } = render(ui(running));
    await userEvent.click(screen.getByRole("button", { name: "Bet next round" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Queued bet" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Bet next round" }));
    rerender(ui({ ...running, playerBlocker: "Your session expired: renew it in the account panel." }));
    expect(screen.queryByRole("region", { name: "Queued bet" })).not.toBeInTheDocument();
    expect(screen.getByText(/Queued bet cancelled/)).toBeInTheDocument();
  });

  it("points to buying coins when the balance cannot cover the stake", () => {
    render(ui(game({ balance: 0n })));
    expect(screen.getByRole("link", { name: /Buy coins/ })).toHaveAttribute("href", "#buy-coins");
  });

  it("celebrates a win only once its settlement is reflected in the balance", () => {
    const bet = { roundId: 7n, stake: 1_000_000n, autoCashOut: 15_000n, exposure: 1_500_000n, cashOutTick: null };
    const crashed = round({ phase: "crashed", startTick: 1_000n, crashPoint: 20_000n, crashTick: 29n });
    const { rerender } = render(ui(game({ round: crashed, myBet: bet, balance: 9_000_000n })));
    expect(screen.getByText(/won 1.50 at 1.50x/)).toBeInTheDocument();
    expect(screen.queryByText(/\+1.50 coins/)).not.toBeInTheDocument();
    rerender(ui(game({ round: round({ roundId: 8n }), myBet: null, balance: 10_500_000n })));
    expect(screen.getByText(/\+1.50 coins/)).toBeInTheDocument();
  });

  it("stops offering a cash-out once a crash from the live feed is verified", async () => {
    const fixture = devnet.rounds.find((candidate) => candidate.phase === "Settled")!;
    const roundId = BigInt(fixture.roundId);
    renderPanel(
      game({
        round: round({ roundId, phase: "running", startTick: 1_000n, commitHex: fixture.commit, vrfOutputHex: fixture.vrfOutput }),
        estimatedTick: () => 1_000n,
        programIdHex: devnet.programId,
        revealHint: { roundId, seedHex: fixture.seed },
        myBet: { roundId, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: null },
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /Cash out/ })).not.toBeInTheDocument());
    expect(screen.getByText("lost")).toBeInTheDocument();
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
