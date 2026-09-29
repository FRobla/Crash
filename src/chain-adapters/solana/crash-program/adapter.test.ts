// @vitest-environment node
// web3.js key handling fails under jsdom (typed-array realm mismatch); browsers and Node are fine.
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { PlayerAccount, RoundAccount } from "./accounts";
import { CRASH_PROGRAM_ID } from "./deployment";
import { clearSessionKey, loadSessionKey, saveSessionKey, sessionStorageKey, type KeyValueStorage } from "./session-key-store";
import { playerBlocker, sessionView, toLiveRound } from "./view-mapping";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const owner = Keypair.generate().publicKey;

describe("session key store", () => {
  it("round-trips a key per program and owner", () => {
    const storage = memoryStorage();
    const key = Keypair.generate();
    expect(saveSessionKey(storage, CRASH_PROGRAM_ID, owner, key)).toBe(true);
    expect(loadSessionKey(storage, CRASH_PROGRAM_ID, owner)?.publicKey.equals(key.publicKey)).toBe(true);
    expect(loadSessionKey(storage, CRASH_PROGRAM_ID, Keypair.generate().publicKey)).toBeNull();
    clearSessionKey(storage, CRASH_PROGRAM_ID, owner);
    expect(loadSessionKey(storage, CRASH_PROGRAM_ID, owner)).toBeNull();
  });

  it("reports failure instead of pretending a key was stored", () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(saveSessionKey(throwing, CRASH_PROGRAM_ID, owner, Keypair.generate())).toBe(false);
    expect(saveSessionKey(null, CRASH_PROGRAM_ID, owner, Keypair.generate())).toBe(false);
    expect(loadSessionKey(throwing, CRASH_PROGRAM_ID, owner)).toBeNull();
  });

  it("ignores corrupt entries", () => {
    const storage = memoryStorage();
    storage.setItem(sessionStorageKey(CRASH_PROGRAM_ID, owner), "not-a-key");
    expect(loadSessionKey(storage, CRASH_PROGRAM_ID, owner)).toBeNull();
  });
});

function player(session: PlayerAccount["session"]): PlayerAccount {
  return {
    owner,
    username: "alice",
    usernameChangedSlot: 0n,
    balance: 5_000_000n,
    activeBet: null,
    session,
    totalWagered: 0n,
    betsSettled: 0n,
    createdSlot: 0n,
    bump: 255,
  };
}

describe("session view", () => {
  const key = Keypair.generate().publicKey;
  const session = { key, expiresSlot: 1_000n, spendCap: 5_000_000n, spent: 1_000_000n };

  it("is active only with the matching local key, before expiry and with fee budget", () => {
    expect(sessionView(player(session), key, 999n, 1_000_000n).status).toBe("active");
    expect(sessionView(player(session), key, 1_000n, 1_000_000n).status).toBe("active");
    expect(sessionView(player(session), key, 1_001n, 1_000_000n).status).toBe("expired");
    expect(sessionView(player(session), Keypair.generate().publicKey, 999n, 1_000_000n).status).toBe("other-device");
    expect(sessionView(player(session), null, 999n, 1_000_000n).status).toBe("other-device");
    expect(sessionView(player(session), key, 999n, 9_999n).status).toBe("out-of-fees");
    expect(sessionView(player(null), key, 999n, 1_000_000n).status).toBe("none");
  });

  it("blocks betting with an explanation until everything is ready", () => {
    expect(playerBlocker(false, undefined, "none")).toMatch(/Connect a wallet/);
    expect(playerBlocker(true, undefined, "none")).toMatch(/Loading/);
    expect(playerBlocker(true, null, "none")).toMatch(/Create an account/);
    expect(playerBlocker(true, player(session), "expired")).toMatch(/expired/);
    expect(playerBlocker(true, player(session), "active")).toBeNull();
  });
});

describe("live round mapping", () => {
  const base = {
    roundId: 4n,
    rulesVersion: 1,
    commit: new Uint8Array(32).fill(0xab),
    openedSlot: 1n,
    bettingEndSlot: 51n,
    entropyDeadlineSlot: 0n,
    randomnessAccount: owner,
    randomnessSeedSlot: 0n,
    startSlot: 0n,
    revealDeadlineSlot: 0n,
    vrfOutput: new Uint8Array(32),
    seed: new Uint8Array(32),
    crashPoint: 0n,
    crashTick: 0n,
    totalExposure: 0n,
    betCount: 3,
    settledCount: 0,
    bump: 1,
  } satisfies Omit<RoundAccount, "phase">;

  it("never exposes a crash point before the reveal", () => {
    const running = toLiveRound({ ...base, phase: "Running", startSlot: 60n, crashPoint: 99n });
    expect(running).toMatchObject({ phase: "running", startTick: 60n, crashPoint: null, crashTick: null });
    const crashed = toLiveRound({ ...base, phase: "Crashed", startSlot: 60n, crashPoint: 25_000n, crashTick: 39n });
    expect(crashed).toMatchObject({ phase: "crashed", crashPoint: 25_000n, crashTick: 39n });
    expect(toLiveRound({ ...base, phase: "Betting" })).toMatchObject({ startTick: null, commitHex: "ab".repeat(32) });
  });
});
