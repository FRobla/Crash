import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bet, CashOutRequest } from "./bet";
import { betExposure } from "./limits";
import { createMultiplierCurve, firstTickAtLeast, recognizedMultiplierAtTick } from "./multiplier-curve";
import { refundRound, settleForfeitedRound, settleRound } from "./settle-round";

const maxMultiplier = 1_000_000n; // 100x
const curve = createMultiplierCurve(24_000n, maxMultiplier);
const horizon = curve.points.length;

const TICK_AT_150 = firstTickAtLeast(curve, 15_000n);
const TICK_BELOW_150 = TICK_AT_150 - 1;

describe("settleRound", () => {
  it("pays a manual cash-out recognized before the crash at its recognized multiplier", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: null }];
    const multiplier = recognizedMultiplierAtTick(curve, 10);
    const result = settleRound(bets, [{ betId: "a", tick: 10 }], 20_000n, curve);
    expect(result.settlements).toEqual([
      { betId: "a", stake: 1_000n, outcome: "cashed-out", multiplier, payout: (1_000n * multiplier) / 10_000n },
    ]);
  });

  it("loses a manual cash-out recognized at or after the crash tick", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: null }];
    const crashPoint = recognizedMultiplierAtTick(curve, 10);
    expect(settleRound(bets, [{ betId: "a", tick: 10 }], crashPoint, curve).settlements[0].outcome).toBe(
      "cashed-out",
    );
    expect(settleRound(bets, [{ betId: "a", tick: 11 }], crashPoint, curve).settlements[0]).toEqual({
      betId: "a",
      stake: 1_000n,
      outcome: "lost",
      payout: 0n,
    });
  });

  it("pays an auto cash-out exactly its target when the target does not exceed the crash point", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: 15_000n }];
    expect(settleRound(bets, [], 15_000n, curve).settlements[0]).toMatchObject({
      outcome: "cashed-out",
      multiplier: 15_000n,
      payout: 1_500n,
    });
    expect(settleRound(bets, [], 14_900n, curve).settlements[0].outcome).toBe("lost");
  });

  it("prefers the earlier of manual and auto, and auto on a tick tie", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: 15_000n }];
    const earlier = settleRound(bets, [{ betId: "a", tick: TICK_BELOW_150 }], 30_000n, curve);
    expect(earlier.settlements[0]).toMatchObject({
      multiplier: recognizedMultiplierAtTick(curve, TICK_BELOW_150),
    });
    const tie = settleRound(bets, [{ betId: "a", tick: TICK_AT_150 }], 30_000n, curve);
    expect(tie.settlements[0]).toMatchObject({ multiplier: 15_000n });
  });

  it("ignores requests below 1.01x and keeps the bet active", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: null }];
    const result = settleRound(bets, [{ betId: "a", tick: 0 }], 30_000n, curve);
    expect(result.settlements[0].outcome).toBe("lost");
    expect(result.ignored).toEqual([{ request: { betId: "a", tick: 0 }, reason: "below-minimum-multiplier" }]);
  });

  it("ignores unknown bets and invalid ticks in canonical order", () => {
    const bets: Bet[] = [{ id: "a", stake: 1_000n, autoCashOut: null }];
    const result = settleRound(
      bets,
      [
        { betId: "z", tick: 3 },
        { betId: "a", tick: Number.NaN },
        { betId: "a", tick: -1 },
        { betId: "a", tick: 2.5 },
      ],
      30_000n,
      curve,
    );
    expect(result.ignored.map(({ request, reason }) => [request.betId, request.tick, reason])).toEqual([
      ["a", -1, "invalid-tick"],
      ["a", 2.5, "invalid-tick"],
      ["a", Number.NaN, "invalid-tick"],
      ["z", 3, "unknown-bet"],
    ]);
  });

  it("never lets any cash-out win on a 1.00x round", () => {
    const bets: Bet[] = [
      { id: "a", stake: 1_000n, autoCashOut: 10_100n },
      { id: "b", stake: 1_000n, autoCashOut: null },
    ];
    const result = settleRound(bets, [{ betId: "b", tick: 0 }], 10_000n, curve);
    expect(result.totalPayout).toBe(0n);
  });

  it.each([
    [[{ id: "a", stake: 1n, autoCashOut: null }, { id: "a", stake: 1n, autoCashOut: null }]],
    [[{ id: "a", stake: -1n, autoCashOut: null }]],
    [[{ id: "a", stake: 1n, autoCashOut: 10_000n }]],
    [[{ id: "a", stake: 1n, autoCashOut: 15_050n }]],
    [[{ id: "a", stake: 1n, autoCashOut: 1_000_100n }]],
  ] as [Bet[]][])("rejects structurally invalid bets %o", (bets) => {
    expect(() => settleRound(bets, [], 20_000n, curve)).toThrow(RangeError);
  });

  it.each([9_900n, 1_000_100n])("rejects crash point %s outside [1.00x, maxMultiplier]", (crashPoint) => {
    expect(() => settleRound([], [], crashPoint, curve)).toThrow(RangeError);
  });
});

describe("refundRound", () => {
  it("refunds exactly every stake", () => {
    const result = refundRound([
      { id: "a", stake: 1_000n, autoCashOut: null },
      { id: "b", stake: 7n, autoCashOut: 20_000n },
    ]);
    expect(result.totalPayout).toBe(1_007n);
    expect(result.totalPayout).toBe(result.totalStake);
    expect(result.settlements.every((settlement) => settlement.outcome === "refunded")).toBe(true);
  });
});

// ---- Properties (spec §9) ----

const centiMultiplier = (min: bigint, max: bigint) =>
  fc.bigInt({ min: min / 100n, max: max / 100n }).map((centi) => centi * 100n);

const betsArbitrary = fc.uniqueArray(
  fc.record({
    id: fc.constantFrom("a", "b", "c", "d", "e", "f"),
    stake: fc.bigInt({ min: 0n, max: 10n ** 15n }),
    autoCashOut: fc.option(centiMultiplier(10_100n, maxMultiplier), { nil: null }),
  }),
  { selector: (bet) => bet.id, maxLength: 6 },
);

const cashOutsArbitrary = fc.array(
  fc.record({
    betId: fc.constantFrom("a", "b", "c", "d", "e", "f", "unknown"),
    tick: fc.oneof(fc.integer({ min: 0, max: horizon + 5 }), fc.constantFrom(-1, 0.5)),
  }),
  { maxLength: 20 },
);

const crashPointArbitrary = centiMultiplier(10_000n, maxMultiplier);

describe("settleRound properties", () => {
  it("pays each bet either 0 or within [stake, exposure]", () => {
    fc.assert(
      fc.property(betsArbitrary, cashOutsArbitrary, crashPointArbitrary, (bets, cashOuts, crashPoint) => {
        const { settlements, totalPayout } = settleRound(bets, cashOuts, crashPoint, curve);
        let totalExposure = 0n;
        settlements.forEach((settlement, index) => {
          const exposure = betExposure(bets[index], maxMultiplier);
          totalExposure += exposure;
          if (settlement.payout !== 0n) {
            expect(settlement.payout).toBeGreaterThanOrEqual(settlement.stake);
            expect(settlement.payout).toBeLessThanOrEqual(exposure);
          }
        });
        expect(totalPayout).toBeLessThanOrEqual(totalExposure);
      }),
    );
  });

  it("only pays cash-outs with 1.01x <= multiplier <= crash point, capped by the auto target", () => {
    fc.assert(
      fc.property(betsArbitrary, cashOutsArbitrary, crashPointArbitrary, (bets, cashOuts, crashPoint) => {
        settleRound(bets, cashOuts, crashPoint, curve).settlements.forEach((settlement, index) => {
          if (settlement.outcome !== "cashed-out") return;
          expect(settlement.multiplier).toBeGreaterThanOrEqual(10_100n);
          expect(settlement.multiplier).toBeLessThanOrEqual(crashPoint);
          const target = bets[index].autoCashOut;
          if (target !== null && target <= crashPoint) {
            expect(settlement.multiplier).toBeLessThanOrEqual(target);
          }
        });
      }),
    );
  });

  it("does not depend on the order of cash-out requests", () => {
    fc.assert(
      fc.property(
        betsArbitrary,
        cashOutsArbitrary.chain((cashOuts) => fc.tuple(fc.constant(cashOuts), fc.shuffledSubarray(cashOuts, { minLength: cashOuts.length, maxLength: cashOuts.length }))),
        crashPointArbitrary,
        (bets, [cashOuts, shuffled], crashPoint) => {
          expect(settleRound(bets, shuffled, crashPoint, curve)).toEqual(
            settleRound(bets, cashOuts, crashPoint, curve),
          );
        },
      ),
    );
  });

  it("is idempotent under duplicated requests", () => {
    fc.assert(
      fc.property(betsArbitrary, cashOutsArbitrary, crashPointArbitrary, (bets, cashOuts, crashPoint) => {
        const once = settleRound(bets, cashOuts, crashPoint, curve);
        const twice = settleRound(bets, [...cashOuts, ...cashOuts], crashPoint, curve);
        expect(twice.settlements).toEqual(once.settlements);
        expect(twice.totalPayout).toBe(once.totalPayout);
      }),
    );
  });

  it("never lowers a bet's payout when the crash point is higher", () => {
    fc.assert(
      fc.property(
        betsArbitrary,
        cashOutsArbitrary,
        crashPointArbitrary,
        crashPointArbitrary,
        (bets, cashOuts, first, second) => {
          const [low, high] = first <= second ? [first, second] : [second, first];
          const lowResult = settleRound(bets, cashOuts, low, curve);
          const highResult = settleRound(bets, cashOuts, high, curve);
          highResult.settlements.forEach((settlement, index) => {
            expect(settlement.payout).toBeGreaterThanOrEqual(lowResult.settlements[index].payout);
          });
        },
      ),
    );
  });
});

describe("settleForfeitedRound", () => {
  it("never costs the house less than revealing any crash point", () => {
    fc.assert(
      fc.property(betsArbitrary, cashOutsArbitrary, crashPointArbitrary, (bets, cashOuts, crashPoint) => {
        const forfeited = settleForfeitedRound(bets, cashOuts, curve);
        const revealed = settleRound(bets, cashOuts, crashPoint, curve);
        expect(forfeited.totalPayout).toBeGreaterThanOrEqual(revealed.totalPayout);
        forfeited.settlements.forEach((settlement, index) => {
          expect(settlement.payout).toBeGreaterThanOrEqual(revealed.settlements[index].payout);
          expect(settlement.payout).toBeLessThanOrEqual(betExposure(bets[index], maxMultiplier));
        });
      }),
    );
  });

  it("refunds bets that never cashed out", () => {
    const bets: Bet[] = [
      { id: "a", stake: 1_000n, autoCashOut: null },
      { id: "b", stake: 500n, autoCashOut: 20_000n },
    ];
    const cashOuts: CashOutRequest[] = [{ betId: "a", tick: 0 }];
    expect(settleForfeitedRound(bets, cashOuts, curve).settlements).toEqual([
      { betId: "a", stake: 1_000n, outcome: "refunded", payout: 1_000n },
      { betId: "b", stake: 500n, outcome: "cashed-out", multiplier: 20_000n, payout: 1_000n },
    ]);
  });
});
