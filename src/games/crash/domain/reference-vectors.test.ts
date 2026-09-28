import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Bet, CashOutRequest } from "./bet";
import { crashPointFromEntropy, ENTROPY_BYTES, UNIFORM_RANGE, uniformFromEntropy } from "./crash-point";
import { validateBet, type BetLimits } from "./limits";
import { createMultiplierCurve, crashTick, firstTickAtLeast } from "./multiplier-curve";
import { CRASH_RULES_V1, type CrashRules } from "./rules";
import { refundRound, settleForfeitedRound, settleRound } from "./settle-round";

/**
 * Golden reference vectors (spec §5.1) consumed by other implementations such as the on-chain
 * program. Regenerate deliberately with `pnpm vitest run reference-vectors -u` after a rules change.
 * Every input is derived from public labels; nothing here is secret.
 */

const VECTORS_PATH = "../../../../docs/specs/vectors/crash-rules-v1.json";

function sha256(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(label).digest());
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Entropy whose first 52 bits encode `uniform` and whose remaining bits are zero. */
function entropyForUniform(uniform: bigint): Uint8Array {
  const entropy = new Uint8Array(ENTROPY_BYTES);
  let value = uniform << 4n;
  for (let index = 6; index >= 0; index -= 1) {
    entropy[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return entropy;
}

/** Deterministic stream of pseudo-random bigints from public labels. */
function labelStream(label: string): (bound: bigint) => bigint {
  let counter = 0;
  return (bound) => {
    const digest = sha256(`${label}/${counter}`);
    counter += 1;
    return BigInt(`0x${toHex(digest.subarray(0, 16))}`) % bound;
  };
}

function buildVectors(rules: CrashRules) {
  const curve = createMultiplierCurve(rules.growthPpm, rules.maxMultiplier);
  const tag = `crash-rules-v${rules.version}`;

  const crashPointCase = (name: string, entropy: Uint8Array) => ({
    name,
    entropy: toHex(entropy),
    uniform: uniformFromEntropy(entropy),
    crashPoint: crashPointFromEntropy(entropy, rules),
  });

  const edgeCases = [
    crashPointCase("all-zero", new Uint8Array(ENTROPY_BYTES)),
    crashPointCase("all-ones", new Uint8Array(ENTROPY_BYTES).fill(0xff)),
  ];
  // Exact thresholds (spec §8): the smallest uniform reaching each target and the one just below.
  const thresholdCases = [101n, 200n, 1_000n, rules.maxMultiplier / 100n].flatMap((centi) => {
    const winning = ((10_000n - rules.houseEdgeBps) * UNIFORM_RANGE) / (100n * centi);
    const threshold = UNIFORM_RANGE - winning;
    return [
      crashPointCase(`threshold-${centi}-centi`, entropyForUniform(threshold)),
      crashPointCase(`below-threshold-${centi}-centi`, entropyForUniform(threshold - 1n)),
    ];
  });
  const hashedCases = Array.from({ length: 50 }, (_, index) =>
    crashPointCase(`hashed-${index}`, sha256(`${tag}/entropy/${index}`)),
  );

  const revealCase = (name: string, bets: Bet[], cashOuts: CashOutRequest[], crashPoint: bigint) => ({
    name,
    kind: "reveal",
    crashPoint,
    crashTick: crashTick(curve, crashPoint),
    bets,
    cashOuts,
    expected: settleRound(bets, cashOuts, crashPoint, curve),
  });
  const twoXTick = firstTickAtLeast(curve, 20_000n);
  const settlementCases: Record<string, unknown>[] = [
    revealCase("auto-and-manual-same-tick-auto-wins", [{ id: "a", stake: 1_000n, autoCashOut: 20_000n }], [{ betId: "a", tick: twoXTick }], 30_000n),
    revealCase("manual-before-auto", [{ id: "a", stake: 1_000n, autoCashOut: 20_000n }], [{ betId: "a", tick: twoXTick - 1 }], 30_000n),
    revealCase("manual-at-last-winning-tick", [{ id: "a", stake: 1_000n, autoCashOut: null }], [{ betId: "a", tick: crashTick(curve, 20_000n) - 1 }], 20_000n),
    revealCase("manual-at-crash-tick-loses", [{ id: "a", stake: 1_000n, autoCashOut: null }], [{ betId: "a", tick: crashTick(curve, 20_000n) }], 20_000n),
    revealCase("auto-equal-to-crash-point-wins", [{ id: "a", stake: 1_000n, autoCashOut: 20_000n }], [], 20_000n),
    revealCase("auto-above-crash-point-loses", [{ id: "a", stake: 1_000n, autoCashOut: 20_100n }], [], 20_000n),
    revealCase("instant-crash-nobody-wins", [{ id: "a", stake: 1_000n, autoCashOut: 10_100n }, { id: "b", stake: 1_000n, autoCashOut: null }], [{ betId: "b", tick: 0 }], 10_000n),
    revealCase("duplicate-and-late-requests", [{ id: "a", stake: 999n, autoCashOut: null }], [{ betId: "a", tick: 12 }, { betId: "a", tick: 5 }, { betId: "a", tick: 5 }, { betId: "a", tick: 150 }], 50_000n),
    revealCase("payout-truncates-toward-house", [{ id: "a", stake: 99n, autoCashOut: 10_100n }, { id: "b", stake: 1n, autoCashOut: 19_900n }], [], 20_000n),
  ];
  for (let index = 0; index < 30; index += 1) {
    const next = labelStream(`${tag}/settlement/${index}`);
    const crashPoint = crashPointFromEntropy(sha256(`${tag}/settlement/${index}/entropy`), rules);
    const endTick = crashTick(curve, crashPoint);
    const bets: Bet[] = Array.from({ length: Number(next(4n)) + 1 }, (_, betIndex) => ({
      id: `bet-${betIndex}`,
      stake: next(10n ** 12n) + 1n,
      autoCashOut: next(2n) === 0n ? null : (next(rules.maxMultiplier / 100n - 100n) + 101n) * 100n,
    }));
    const cashOuts: CashOutRequest[] = bets.flatMap((bet) =>
      Array.from({ length: Number(next(3n)) }, () => ({
        betId: bet.id,
        // Spread requests around the crash tick so both winning and late requests appear.
        tick: Number(next(BigInt(endTick + 3))),
      })),
    );
    const kind = index % 10 === 9 ? "forfeit" : index % 10 === 8 ? "refund" : "reveal";
    const expected =
      kind === "reveal"
        ? settleRound(bets, cashOuts, crashPoint, curve)
        : kind === "forfeit"
          ? settleForfeitedRound(bets, cashOuts, curve)
          : refundRound(bets);
    settlementCases.push({
      name: `${kind}-${index}`,
      kind,
      crashPoint: kind === "reveal" ? crashPoint : null,
      crashTick: kind === "reveal" ? endTick : null,
      bets,
      cashOuts,
      expected,
    });
  }

  const limits: BetLimits = {
    minStake: 1_000_000n,
    maxStake: 10_000_000_000n,
    maxPayout: 100_000_000_000n,
    maxRoundExposure: 1_000_000_000_000n,
  };
  const betValidationCases = [
    ["min-stake", 1_000_000n, null],
    ["below-min-stake", 999_999n, null],
    ["max-stake-with-auto", 10_000_000_000n, 20_000n],
    ["above-max-stake", 10_000_000_001n, 20_000n],
    ["not-centi-precise", 1_000_000n, 20_050n],
    ["auto-below-minimum", 1_000_000n, 10_000n],
    ["auto-at-minimum", 1_000_000n, 10_100n],
    ["auto-at-maximum", 1_000_000n, rules.maxMultiplier],
    ["auto-above-maximum", 1_000_000n, rules.maxMultiplier + 100n],
    ["payout-at-maximum", 1_000_000_000n, null],
    ["payout-above-maximum", 1_000_000_001n, null],
  ] as const;

  return {
    description:
      "Reference vectors for Crash rules. bigint values are decimal strings; multipliers are in ten-thousandths (1.0000x = 10000); entropy is hex. See docs/specs/crash-round-rules.md.",
    rulesVersion: rules.version,
    rules: {
      houseEdgeBps: rules.houseEdgeBps,
      growthPpm: rules.growthPpm,
      maxMultiplier: rules.maxMultiplier,
    },
    curve: curve.points,
    crashPoints: [...edgeCases, ...thresholdCases, ...hashedCases],
    settlements: settlementCases,
    betValidation: {
      limits,
      maxMultiplier: rules.maxMultiplier,
      cases: betValidationCases.map(([name, stake, autoCashOut]) => ({
        name,
        bet: { stake, autoCashOut },
        expected: validateBet({ stake, autoCashOut }, limits, rules.maxMultiplier),
      })),
    },
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;
}

describe("reference vectors", () => {
  it("are deterministic", () => {
    expect(serialize(buildVectors(CRASH_RULES_V1))).toBe(serialize(buildVectors(CRASH_RULES_V1)));
  });

  it("match the committed crash-rules-v1.json", async () => {
    await expect(serialize(buildVectors(CRASH_RULES_V1))).toMatchFileSnapshot(VECTORS_PATH);
  });
});
