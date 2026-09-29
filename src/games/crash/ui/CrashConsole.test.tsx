import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import devnet from "../fairness/fixtures/devnet-rounds.json";
import { CRASH_HOLD_MS, CrashConsole } from "./CrashConsole";
import { CrashGameProvider, type CrashGamePort, type LiveRound } from "./crash-game";
import { ONE_X } from "../domain/units";
import { MAX_LAG_TICKS, presentationLag } from "./presentation-lag";

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
    betCount: 2,
    ...overrides,
  };
}

function game(overrides: Partial<CrashGamePort> = {}): CrashGamePort {
  const tick = overrides.estimatedTick?.() ?? 1_000n;
  return {
    connection: "live",
    paused: false,
    limits: null,
    round: round(),
    estimatedTick: () => tick,
    projectedTick: () => Number(tick),
    msPerTick: () => 400,
    revealHint: null,
    liveFeed: "off",
    programIdHex: "00".repeat(32),
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

function ui(port: CrashGamePort) {
  return (
    <CrashGameProvider value={port}>
      <CrashConsole />
    </CrashGameProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CrashConsole", () => {
  it("shows the betting countdown and marks the current lifecycle step", () => {
    render(ui(game()));
    expect(screen.getByText("Betting open, closes in about 20 seconds")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Betting open");
    expect(screen.getByText("Bets").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/2 bets in round #7/)).toBeInTheDocument();
  });

  it("counts down with the measured tick length, not the nominal 400 ms", () => {
    render(ui(game({ round: round({ bettingEndTick: 1_066n }), msPerTick: () => 230 })));
    // 66 ticks × 230 ms = 15.18 s.
    expect(screen.getByText("Betting open, closes in about 16 seconds")).toBeInTheDocument();
    expect(screen.getByText("15.2s")).toBeInTheDocument();
  });

  it("shows a skeleton, not an idle round, while the first data loads", () => {
    render(ui(game({ connection: "connecting", round: null })));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the live round");
    expect(screen.queryByText(/idle/)).not.toBeInTheDocument();
  });

  it("shows the launch state while waiting for randomness", () => {
    render(ui(game({ round: round({ phase: "awaiting-entropy" }) })));
    expect(screen.getByRole("status")).toHaveTextContent(/launching once verifiable randomness arrives/);
    expect(screen.getByText("Launch").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("labels the running multiplier as an estimate", () => {
    render(ui(game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_030n })));
    expect(screen.getByText("Running, estimated multiplier 2.03x")).toBeInTheDocument();
    expect(screen.getByText(/estimated from the slot clock/)).toBeInTheDocument();
    expect(screen.getByText("Live").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("shows the revealed crash point once the round ends", () => {
    render(ui(game({ round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }) })));
    expect(screen.getByText("Crashed at 1.50x")).toBeInTheDocument();
    expect(screen.getByText(/revealed on-chain/)).toBeInTheDocument();
  });

  it("stops the curve at a crash verified from the live feed, labeled as pending the on-chain reveal", async () => {
    const fixture = devnet.rounds.find((candidate) => candidate.phase === "Settled")!;
    const running = round({
      roundId: BigInt(fixture.roundId),
      phase: "running",
      commitHex: fixture.commit,
      vrfOutputHex: fixture.vrfOutput,
      startTick: 1_000n,
    });
    // Far enough past the start that the lagged curve has reached any crash tick.
    const past = 1_000n + BigInt(fixture.crashTick ?? 0) + BigInt(MAX_LAG_TICKS) + 1n;
    render(
      ui(
        game({
          round: running,
          estimatedTick: () => past,
          programIdHex: devnet.programId,
          revealHint: { roundId: running.roundId, seedHex: fixture.seed },
          liveFeed: "live",
        }),
      ),
    );
    expect(await screen.findByText(/verified against the commit · on-chain reveal pending/)).toBeInTheDocument();
    expect(screen.getByText("crank:")).toBeInTheDocument();
  });

  it("never shows more than a 1.00x crash learned a few ticks after the start", () => {
    let projected = 1_002;
    const at = (phase: "running" | "crashed") =>
      game({
        round: round({ roundId: 900n, phase, startTick: 1_000n, ...(phase === "crashed" ? { crashPoint: ONE_X, crashTick: 0n } : {}) }),
        estimatedTick: () => BigInt(Math.floor(projected)),
        projectedTick: () => projected,
      });
    const { rerender } = render(ui(at("running")));
    expect(screen.getByText("1.00x")).toBeInTheDocument();
    // Learned 3 ticks after the start, within the playout lag: the curve never took off.
    projected = 1_003;
    rerender(ui(at("crashed")));
    expect(screen.getByText("Crashed at 1.00x")).toBeInTheDocument();
    expect(screen.getByText("1.00x")).toBeInTheDocument();
  });

  it("plays a crash learned late out to its crash point, never past it, then shows it", () => {
    vi.useFakeTimers();
    const lag = presentationLag.forRound(901n);
    let projected = 1_010 + lag;
    const at = (phase: "running" | "crashed") =>
      game({
        round: round({ roundId: 901n, phase, startTick: 1_000n, ...(phase === "crashed" ? { crashPoint: 15_000n, crashTick: 18n } : {}) }),
        estimatedTick: () => BigInt(Math.floor(projected)),
        projectedTick: () => projected,
      });
    const { rerender } = render(ui(at("running")));
    projected = 1_014 + lag;
    rerender(ui(at("crashed")));
    expect(screen.queryByText(/^Crashed at/)).not.toBeInTheDocument();
    expect(screen.getByText(/estimated from the slot clock/)).toBeInTheDocument();
    projected = 1_018 + lag;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Crashed at 1.50x")).toBeInTheDocument();
  });

  it("still shows a crash being played out when the next round opens before the curve gets there", () => {
    vi.useFakeTimers();
    const lag = presentationLag.forRound(902n);
    let projected = 1_010 + lag;
    const port = (overrides: Partial<LiveRound>) =>
      game({
        round: round({ roundId: 902n, startTick: 1_000n, ...overrides }),
        estimatedTick: () => BigInt(Math.floor(projected)),
        projectedTick: () => projected,
      });
    const { rerender } = render(ui(port({ phase: "running" })));
    projected = 1_014 + lag;
    rerender(ui(port({ phase: "crashed", crashPoint: 15_000n, crashTick: 18n })));
    // The crank reveals and opens the next round at once.
    rerender(ui(port({ roundId: 903n, phase: "betting", startTick: null, openedTick: 1_020n, bettingEndTick: 1_086n })));
    expect(screen.queryByText(/^Crashed at/)).not.toBeInTheDocument();
    expect(screen.getByText(/estimated from the slot clock/)).toBeInTheDocument();
    projected = 1_018 + lag;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("1.50x")).toBeInTheDocument();
    expect(screen.getByText("crashed")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(CRASH_HOLD_MS + 1_000);
    });
    expect(screen.queryByText("1.50x")).not.toBeInTheDocument();
    expect(screen.getByText(/2 bets in round #903/)).toBeInTheDocument();
  });

  it("keeps a crash on screen for a moment after the next round opens, then shows its countdown", () => {
    vi.useFakeTimers();
    const crashed = game({ round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }) });
    const { rerender } = render(ui(crashed));
    rerender(ui(game({ round: round({ roundId: 8n, openedTick: 1_020n, bettingEndTick: 1_086n }), estimatedTick: () => 1_021n })));
    expect(screen.getByText("1.50x")).toBeInTheDocument();
    expect(screen.getByText(/next round/)).toHaveTextContent("next round #8 · betting open");
    act(() => {
      vi.advanceTimersByTime(CRASH_HOLD_MS + 1_000);
    });
    expect(screen.queryByText("1.50x")).not.toBeInTheDocument();
    expect(screen.getByText(/2 bets in round #8/)).toBeInTheDocument();
  });

  it("waits at 1.00x where the curve starts, and keeps the number in place at take-off", () => {
    const { rerender } = render(ui(game({ round: round({ phase: "awaiting-entropy" }) })));
    const launching = screen.getByText("1.00x");
    rerender(ui(game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_000n })));
    expect(screen.getByText("1.00x")).toBe(launching);
  });

  it("marks a recorded cash-out as pending the reveal, not as a win", () => {
    const bet = { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: 18n };
    render(ui(game({ round: round({ phase: "running", startTick: 1_000n }), estimatedTick: () => 1_030n, myBet: bet })));
    expect(screen.getByText("cashed out 1.53x")).toBeInTheDocument();
    expect(screen.getByText(/1\.53 coins if the crash point is ≥ 1\.53x/)).toBeInTheDocument();
    expect(screen.queryByText(/won/)).not.toBeInTheDocument();
  });

  it("shows the win once the crash point decides it, pending settlement", () => {
    const bet = { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: 10n };
    render(ui(game({ round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }), myBet: bet })));
    expect(screen.getByText(/\+1\.26 coins/)).toBeInTheDocument();
    expect(screen.getByText(/won at 1\.26x · pending settlement/)).toBeInTheDocument();
  });

  it("says plainly when a recorded cash-out came after the crash", () => {
    const bet = { roundId: 7n, stake: 1_000_000n, autoCashOut: 0n, exposure: 100_000_000n, cashOutTick: 25n };
    render(ui(game({ round: round({ phase: "crashed", startTick: 1_000n, crashPoint: 15_000n, crashTick: 18n }), myBet: bet })));
    expect(screen.getByText(/came after the crash/)).toBeInTheDocument();
    expect(screen.queryByText(/won/)).not.toBeInTheDocument();
  });

  it("flags voided rounds outside the normal lifecycle", () => {
    render(ui(game({ round: round({ phase: "voided" }) })));
    expect(screen.getByText("Round voided, stakes refunded")).toBeInTheDocument();
    expect(screen.getAllByText("voided").length).toBeGreaterThan(0);
  });
});
