// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      pauseBetweenRoundsMs: 3_000,
      priorityFeeMicroLamports: 1_000,
    });
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

describe("logger", () => {
  it("writes one JSON object per line", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info("open", { roundId: "3" });
    expect(JSON.parse(lines[0])).toMatchObject({ level: "info", event: "open", roundId: "3" });
  });
});
