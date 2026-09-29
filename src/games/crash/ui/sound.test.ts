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
