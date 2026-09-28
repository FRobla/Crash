import { describe, expect, it } from "vitest";
import type { BetLimits } from "./limits";
import {
  applyTransition,
  createRound,
  placeBet,
  transitionPhase,
  type RoundPhase,
  type RoundState,
  type RoundTransition,
} from "./round-lifecycle";

const maxMultiplier = 1_000_000n;
const limits: BetLimits = { minStake: 1n, maxStake: 1_000n, maxPayout: 100_000n, maxRoundExposure: 150_000n };

const PHASES: RoundPhase[] = [
  "betting",
  "awaiting-entropy",
  "running",
  "crashed",
  "settled",
  "voided",
  "forfeited",
];
const TRANSITIONS: RoundTransition[] = ["close-betting", "start", "crash", "settle", "void", "forfeit"];

const VALID: Record<string, RoundPhase> = {
  "betting/close-betting": "awaiting-entropy",
  "betting/void": "voided",
  "awaiting-entropy/start": "running",
  "awaiting-entropy/void": "voided",
  "running/crash": "crashed",
  "running/forfeit": "forfeited",
  "crashed/settle": "settled",
};

describe("transitionPhase", () => {
  const cases = PHASES.flatMap((phase) => TRANSITIONS.map((transition) => [phase, transition] as const));

  it.each(cases)("from %s via %s follows the spec table", (phase, transition) => {
    const expected = VALID[`${phase}/${transition}`];
    expect(transitionPhase(phase, transition)).toEqual(
      expected === undefined
        ? { ok: false, error: { code: "invalid-transition", from: phase, transition } }
        : { ok: true, value: expected },
    );
  });

  it("cannot void a round once it is running", () => {
    expect(transitionPhase("running", "void").ok).toBe(false);
    expect(transitionPhase("crashed", "void").ok).toBe(false);
  });
});

describe("placeBet", () => {
  function unwrap(result: ReturnType<typeof placeBet>): RoundState {
    if (!result.ok) throw new Error(`unexpected rejection: ${result.error}`);
    return result.value;
  }

  it("accumulates accepted bets and their exposure", () => {
    let round = createRound();
    round = unwrap(placeBet(round, { id: "a", stake: 1_000n, autoCashOut: null }, limits, maxMultiplier));
    round = unwrap(placeBet(round, { id: "b", stake: 1_000n, autoCashOut: 20_000n }, limits, maxMultiplier));
    expect(round.bets.map((bet) => bet.id)).toEqual(["a", "b"]);
    expect(round.exposure).toBe(102_000n);
  });

  it("rejects duplicate ids and bets over the round exposure", () => {
    const round = unwrap(placeBet(createRound(), { id: "a", stake: 1_000n, autoCashOut: null }, limits, maxMultiplier));
    expect(placeBet(round, { id: "a", stake: 1n, autoCashOut: null }, limits, maxMultiplier)).toEqual({
      ok: false,
      error: "duplicate-bet",
    });
    expect(placeBet(round, { id: "b", stake: 501n, autoCashOut: null }, limits, maxMultiplier)).toEqual({
      ok: false,
      error: "round-exposure-exceeded",
    });
    expect(placeBet(round, { id: "b", stake: 500n, autoCashOut: null }, limits, maxMultiplier).ok).toBe(true);
  });

  it("forwards per-bet limit rejections", () => {
    expect(placeBet(createRound(), { id: "a", stake: 0n, autoCashOut: null }, limits, maxMultiplier)).toEqual({
      ok: false,
      error: "stake-below-minimum",
    });
  });

  it.each(PHASES.filter((phase) => phase !== "betting"))("rejects bets in phase %s", (phase) => {
    const round: RoundState = { ...createRound(), phase };
    expect(placeBet(round, { id: "a", stake: 1n, autoCashOut: null }, limits, maxMultiplier)).toEqual({
      ok: false,
      error: "betting-closed",
    });
  });

  it("keeps bets and exposure across transitions", () => {
    const round = unwrap(placeBet(createRound(), { id: "a", stake: 10n, autoCashOut: null }, limits, maxMultiplier));
    const closed = applyTransition(round, "close-betting");
    expect(closed).toEqual({ ok: true, value: { ...round, phase: "awaiting-entropy" } });
  });
});
