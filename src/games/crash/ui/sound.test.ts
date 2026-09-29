import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module state per test: the preference is cached after the first read.
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sound preference", () => {
  it("is off by default and remembered once enabled", async () => {
    const sound = await import("./sound");
    expect(sound.soundEnabled()).toBe(false);
    sound.setSoundEnabled(true);
    expect(localStorage.getItem("crashit:sound")).toBe("on");
    vi.resetModules();
    expect((await import("./sound")).soundEnabled()).toBe(true);
  });

  it("works without storage and never throws when audio is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const sound = await import("./sound");
    expect(sound.soundEnabled()).toBe(false);
    expect(() => sound.setSoundEnabled(true)).not.toThrow();
    expect(sound.soundEnabled()).toBe(true);
    expect(() => sound.playSound("crash")).not.toThrow();
  });
});

describe("rise tone", () => {
  it("climbs with the multiplier and is safe without audio", async () => {
    const sound = await import("./sound");
    expect(sound.riseFrequency(1)).toBe(150);
    expect(sound.riseFrequency(0.5)).toBe(150);
    expect(sound.riseFrequency(8)).toBeCloseTo(300);
    expect(sound.riseFrequency(100)).toBeGreaterThan(sound.riseFrequency(10));
    sound.setSoundEnabled(true);
    expect(() => {
      sound.startRise();
      sound.setRise(2);
      sound.stopRise();
    }).not.toThrow();
  });
});
