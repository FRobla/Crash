// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { bettingSlotsFor, parseBettingSeconds, updatedConfigArgs } from "./admin-config-math";
import { isInside, parseOperatorConfig } from "./config";
import { createLogger } from "./logger";
import { createFileSeedStore } from "./seed-store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crash-operator-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("seed store", () => {
  it("persists a seed and never replaces it", () => {
    const dir = tempDir();
    const store = createFileSeedStore(dir);
    const first = store.getOrCreate(5n, () => new Uint8Array(32).fill(1));
    const again = createFileSeedStore(dir).getOrCreate(5n, () => new Uint8Array(32).fill(2));
    expect(again).toEqual(first);
    expect(store.read(5n)).toEqual(new Uint8Array(32).fill(1));
  });

  it("returns null for unknown rounds, removes seeds and rejects corrupt files", () => {
    const dir = tempDir();
    const store = createFileSeedStore(dir);
    expect(store.read(1n)).toBeNull();
    store.getOrCreate(1n, () => new Uint8Array(32).fill(3));
    store.remove(1n);
    expect(store.read(1n)).toBeNull();
    writeFileSync(join(dir, "round-2.seed"), "not hex");
    expect(() => store.read(2n)).toThrow(/round 2 is corrupt/);
    expect(() => store.getOrCreate(3n, () => new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("stores only the seed hex, with no other data", () => {
    const dir = tempDir();
    createFileSeedStore(dir).getOrCreate(9n, () => new Uint8Array(32).fill(0xab));
    expect(readFileSync(join(dir, "round-9.seed"), "utf8")).toBe("ab".repeat(32));
  });
});

describe("operator config", () => {
  const repo = join(tmpdir(), "repo");
  const outside = join(tmpdir(), "outside");

  it("applies the approved defaults", () => {
    const config = parseOperatorConfig(
      { CRASH_OPERATOR_KEYPAIR: join(outside, "id.json"), CRASH_OPERATOR_STATE_DIR: join(outside, "state") },
      repo,
    );
    expect(config).toMatchObject({
      rpcUrl: "https://api.devnet.solana.com",
      pauseBetweenRoundsMs: 0,
      priorityFeeMicroLamports: 1_000,
      liveFeed: { port: 8787, allowedOrigin: "http://localhost:3000" },
    });
  });

  it("treats empty env-file values as defaults and can disable the live feed", () => {
    const base = { CRASH_OPERATOR_KEYPAIR: join(outside, "id.json"), CRASH_OPERATOR_STATE_DIR: join(outside, "state") };
    expect(parseOperatorConfig({ ...base, CRASH_OPERATOR_POLL_MS: "", CRASH_OPERATOR_LIVE_PORT: "" }, repo)).toMatchObject({
      pollIntervalMs: 800,
      liveFeed: { port: 8787 },
    });
    expect(parseOperatorConfig({ ...base, CRASH_OPERATOR_LIVE_PORT: "0" }, repo).liveFeed).toBeNull();
    expect(() => parseOperatorConfig({ ...base, CRASH_OPERATOR_LIVE_ORIGIN: "http://localhost:3000/path" }, repo)).toThrow(
      /CRASH_OPERATOR_LIVE_ORIGIN/,
    );
  });

  it("refuses secrets or seeds inside the repository", () => {
    expect(() =>
      parseOperatorConfig(
        { CRASH_OPERATOR_KEYPAIR: join(repo, "keys", "id.json"), CRASH_OPERATOR_STATE_DIR: join(outside, "s") },
        repo,
      ),
    ).toThrow(/KEYPAIR must point outside/);
    expect(() =>
      parseOperatorConfig({ CRASH_OPERATOR_KEYPAIR: join(outside, "id.json"), CRASH_OPERATOR_STATE_DIR: repo }, repo),
    ).toThrow(/STATE_DIR must point outside/);
    expect(isInside(repo, join(repo, "..", "repo-sibling"))).toBe(false);
  });

  it("rejects missing paths and non-https RPC URLs without echoing values", () => {
    expect(() => parseOperatorConfig({}, repo)).toThrow(/CRASH_OPERATOR_KEYPAIR/);
    const secretUrl = "http://rpc.example/?api-key=SECRET";
    let message = "";
    try {
      parseOperatorConfig(
        { CRASH_OPERATOR_KEYPAIR: join(outside, "k"), CRASH_OPERATOR_STATE_DIR: join(outside, "s"), CRASH_OPERATOR_RPC_URL: secretUrl },
        repo,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CRASH_OPERATOR_RPC_URL/);
    expect(message).not.toContain("SECRET");
  });
});

describe("admin config", () => {
  it("parses whole seconds within bounds, with or without pnpm's `--`", () => {
    expect(parseBettingSeconds(["--", "--betting-seconds", "15"])).toBe(15);
    expect(parseBettingSeconds(["--betting-seconds", "15"])).toBe(15);
    expect(() => parseBettingSeconds([])).toThrow(/usage/);
    expect(() => parseBettingSeconds(["--betting-seconds", "1.5"])).toThrow(/usage/);
    expect(() => parseBettingSeconds(["--betting-seconds", "600"])).toThrow(/between/);
  });

  it("converts seconds to enough slots at the measured rate", () => {
    expect(bettingSlotsFor(15, 230)).toBe(66n);
    expect(bettingSlotsFor(15, 400)).toBe(38n);
    // An implausible measurement is clamped rather than trusted.
    expect(bettingSlotsFor(15, 10)).toBe(100n);
  });

  it("changes only betting_slots", () => {
    const key = PublicKey.unique();
    const config = {
      admin: key,
      operator: key,
      rulesVersion: 1,
      limits: { minStake: 1n, maxStake: 2n, maxPayout: 3n, maxRoundExposure: 4n },
      maxBetsPerRound: 256,
      timeouts: { bettingSlots: 13n, entropyTimeoutSlots: 300n, revealGraceSlots: 150n },
      playerPolicy: { maxSessionSlots: 5n, usernameCooldownSlots: 6n },
      paused: false,
      nextRoundId: 1n,
      currentRound: null,
      randomnessAccount: key,
      bump: 0,
      vaultBump: 0,
      randomnessAuthorityBump: 0,
    };
    expect(updatedConfigArgs(config, 66n)).toEqual({
      operator: key,
      limits: config.limits,
      timeouts: { bettingSlots: 66n, entropyTimeoutSlots: 300n, revealGraceSlots: 150n },
      maxBetsPerRound: 256,
      paused: false,
      playerPolicy: config.playerPolicy,
    });
    expect(() => updatedConfigArgs(config, 0n)).toThrow(/positive/);
  });
});

describe("logger", () => {
  it("writes one JSON object per line", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info("open", { roundId: "3" });
    expect(JSON.parse(lines[0])).toMatchObject({ level: "info", event: "open", roundId: "3" });
  });
});
