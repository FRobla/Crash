import { describe, expect, it } from "vitest";
import { MAX_MS_PER_SLOT, MIN_MS_PER_SLOT, SlotClock, clampMsPerSlot, msPerSlotFromSamples } from "./slot-clock";

describe("msPerSlotFromSamples", () => {
  it("averages performance samples and ignores empty ones", () => {
    expect(msPerSlotFromSamples([{ numSlots: 260, samplePeriodSecs: 60 }, { numSlots: 0, samplePeriodSecs: 60 }])).toBeCloseTo(230.77, 1);
    expect(msPerSlotFromSamples([])).toBeNull();
  });

  it("clamps implausible rates to 150–600 ms", () => {
    expect(msPerSlotFromSamples([{ numSlots: 1_000, samplePeriodSecs: 60 }])).toBe(MIN_MS_PER_SLOT);
    expect(clampMsPerSlot(5_000)).toBe(MAX_MS_PER_SLOT);
    expect(clampMsPerSlot(Number.NaN)).toBe(400);
  });
});

describe("SlotClock", () => {
  it("measures the slot rate by regression over the observations", () => {
    const clock = new SlotClock();
    expect(clock.msPerSlot()).toBe(400);
    // 230 ms slots, observed once a second with ±1 slot of jitter.
    for (let second = 0; second <= 12; second++) {
      const jitter = second % 2 === 0 ? 1 : -1;
      clock.observe(BigInt(1_000 + Math.floor((second * 1000) / 230) + jitter), second * 1000);
    }
    expect(clock.msPerSlot()).toBeGreaterThan(215);
    expect(clock.msPerSlot()).toBeLessThan(245);
  });

  it("keeps the baseline until the observations span a few seconds, and ignores out-of-order slots", () => {
    const clock = new SlotClock(230);
    clock.observe(100n, 0);
    clock.observe(104n, 1_000);
    clock.observe(103n, 1_500);
    expect(clock.msPerSlot()).toBe(230);
    expect(clock.target(2_000)).toBeCloseTo(104 + 1000 / 230, 5);
  });

  it("projects continuously and monotonically, correcting small errors by speed", () => {
    const clock = new SlotClock(250);
    clock.observe(1_000n, 0);
    expect(clock.project(0)).toBe(1_000);
    const before = clock.project(500)!;
    expect(before).toBeCloseTo(1_002, 5);
    // A poll says the cluster is 2 slots further than projected: no jump, it speeds up instead.
    clock.observe(1_006n, 1_000);
    const next = clock.project(600)!;
    expect(next).toBeGreaterThan(before);
    expect(next - before).toBeLessThanOrEqual((100 / 250) * 1.5 + 1e-9);
    let previous = next;
    for (let at = 700; at <= 3_000; at += 16) {
      const value = clock.project(at)!;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeCloseTo(clock.target(3_000)!, 0);
  });

  it("jumps when the error exceeds 8 slots or after a resync", () => {
    const clock = new SlotClock(250);
    clock.observe(1_000n, 0);
    clock.project(0);
    clock.observe(1_020n, 100);
    expect(clock.project(100)).toBeCloseTo(1_020, 5);
    clock.observe(1_023n, 1_000);
    clock.resync();
    expect(clock.project(1_000)).toBeCloseTo(1_023, 5);
  });
});
