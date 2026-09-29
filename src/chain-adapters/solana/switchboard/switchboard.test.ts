// @vitest-environment node
// web3.js PDA derivation fails under jsdom (typed-array realm mismatch); browsers and Node are fine.
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { CRASH_PROGRAM_ID } from "../crash-program/deployment";
import { closeBettingIx, startRoundIx } from "../crash-program/instructions";
import {
  DISCRIMINATORS,
  ORACLE_OFFSETS,
  QUEUE_OFFSETS,
  RANDOMNESS_OFFSETS,
  SWITCHBOARD_PROGRAM_ID,
  parseOracle,
  parseQueue,
  parseRandomness,
  revealSideAccounts,
} from "./accounts";
import { fetchRevealPayload, parseRevealResponse, revealRequestBody } from "./gateway";
import { oracleIneligibility, rankOracles, type OracleCandidate } from "./oracle-selection";
import idl from "./fixtures/switchboard-idl-accounts.json";
import devnet from "./fixtures/devnet-switchboard-accounts.json";
import round3 from "./fixtures/round-3-instruction-accounts.json";

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };

/** bytemuck `repr(C)` size and alignment computed from the pinned IDL. */
function layout(type: IdlType): { size: number; align: number } {
  const primitives: Record<string, number> = { u8: 1, bool: 1, u16: 2, u32: 4, i64: 8, u64: 8, i128: 16, u128: 16, pubkey: 32 };
  if (typeof type === "string") {
    const size = primitives[type];
    if (!size) throw new Error(`unknown primitive ${type}`);
    return { size, align: type === "pubkey" ? 1 : size };
  }
  if ("array" in type) {
    const inner = layout(type.array[0]);
    return { size: inner.size * type.array[1], align: inner.align };
  }
  return structLayout(type.defined.name).total;
}

function structLayout(name: string) {
  const def = idl.types.find((candidate) => candidate.name === name)!;
  const offsets: Record<string, number> = {};
  let offset = 0;
  let align = 1;
  for (const field of (def.type as { fields: { name: string; type: IdlType }[] }).fields) {
    const inner = layout(field.type);
    offset = Math.ceil(offset / inner.align) * inner.align;
    offsets[field.name] = offset;
    offset += inner.size;
    align = Math.max(align, inner.align);
  }
  return { offsets, total: { size: Math.ceil(offset / align) * align, align } };
}

function fixture(account: { owner: string; data: string }) {
  return { owner: new PublicKey(account.owner), data: Uint8Array.from(Buffer.from(account.data, "base64")) };
}

describe("pinned layouts", () => {
  it("match the offsets recomputed from the on-chain IDL", () => {
    const randomness = structLayout("RandomnessAccountData").offsets;
    const queue = structLayout("QueueAccountData").offsets;
    const oracle = structLayout("OracleAccountData").offsets;
    const quote = structLayout("Quote").offsets;
    expect(RANDOMNESS_OFFSETS).toEqual({
      authority: 8 + randomness.authority,
      queue: 8 + randomness.queue,
      seedSlothash: 8 + randomness.seed_slothash,
      seedSlot: 8 + randomness.seed_slot,
      oracle: 8 + randomness.oracle,
      revealSlot: 8 + randomness.reveal_slot,
      value: 8 + randomness.value,
    });
    expect(QUEUE_OFFSETS).toEqual({
      oracleKeys: 8 + queue.oracle_keys,
      oracleKeysCapacity: 78,
      nodeTimeout: 8 + queue.node_timeout,
      oracleKeysLen: 8 + queue.oracle_keys_len,
    });
    expect(ORACLE_OFFSETS).toEqual({
      verificationStatus: 8 + oracle.enclave + quote.verification_status,
      validUntil: 8 + oracle.enclave + quote.valid_until,
      queue: 8 + oracle.queue,
      lastHeartbeat: 8 + oracle.last_heartbeat,
      gatewayUri: 8 + oracle.gateway_uri,
      gatewayUriLength: 64,
      isOnQueue: 8 + oracle.is_on_queue,
    });
    const discriminator = (name: string) => idl.accounts.find((account) => account.name === name)!.discriminator;
    expect(DISCRIMINATORS.randomness).toEqual(discriminator("RandomnessAccountData"));
    expect(DISCRIMINATORS.queue).toEqual(discriminator("QueueAccountData"));
    expect(DISCRIMINATORS.oracle).toEqual(discriminator("OracleAccountData"));
    expect(idl.address).toBe(SWITCHBOARD_PROGRAM_ID.toBase58());
  });
});

describe("real devnet accounts", () => {
  const queueKey = new PublicKey(devnet.queue.address);
  const queue = parseQueue(fixture(devnet.queue));
  const candidates: OracleCandidate[] = devnet.oracles.map((oracle) => ({
    key: new PublicKey(oracle.address),
    data: parseOracle(fixture(oracle)),
  }));
  const now = BigInt(devnet.capturedAtUnix);

  it("parse the house randomness account, its queue and the queue's oracles", () => {
    const randomness = parseRandomness(fixture(devnet.randomness));
    expect(randomness.authority.toBase58()).toBe("46cA9XaCNcmrUyz5Eez7cN3KBPNVAkcDi6axGGJLH87E");
    expect(randomness.queue.equals(queueKey)).toBe(true);
    expect(queue.oracleKeys.map((key) => key.toBase58())).toEqual(devnet.oracles.map((oracle) => oracle.address));
    expect(queue.nodeTimeout).toBe(300n);
    for (const { data } of candidates) {
      expect(data.queue.equals(queueKey)).toBe(true);
      expect(data.gatewayUri).toMatch(/^https:\/\/[\w.-]+\.switchboard-oracles\.xyz\/devnet$/);
    }
  });

  it("reject accounts with a wrong owner or discriminator", () => {
    const queueAccount = fixture(devnet.queue);
    expect(() => parseQueue({ ...queueAccount, owner: CRASH_PROGRAM_ID })).toThrow(/owner/);
    expect(() => parseOracle(queueAccount)).toThrow(/discriminator/);
    expect(() => parseRandomness({ ...queueAccount, data: queueAccount.data.subarray(0, 100) })).toThrow(/short/);
  });

  it("keep only oracles with a fresh heartbeat and a valid quote", () => {
    const reasons = candidates.map((candidate) => oracleIneligibility(candidate, queueKey, queue, now));
    expect(reasons.filter((reason) => reason === null)).toHaveLength(5);
    expect(reasons.filter((reason) => reason === "stale-heartbeat")).toHaveLength(4);
    const ranked = rankOracles(candidates, queueKey, queue, now, new Set([candidates[0].key.toBase58()]), () => 0);
    expect(ranked).toHaveLength(4);
    expect(ranked.some((candidate) => candidate.key.equals(candidates[0].key))).toBe(false);
    expect(rankOracles(candidates, queueKey, queue, now + 10_000n)).toEqual([]);
    const otherQueue = rankOracles(candidates, CRASH_PROGRAM_ID, queue, now);
    expect(otherQueue).toEqual([]);
  });
});

describe("crank instructions against a real round", () => {
  it("rebuild the exact account lists of round 3's close_betting and start_round", () => {
    const [config, round, randomness, , queue, oracle, , switchboardProgram] = round3.closeBetting.accounts.map(
      (key) => new PublicKey(key),
    );
    const close = closeBettingIx(CRASH_PROGRAM_ID, 3n, { randomness, queue, oracle, switchboardProgram });
    expect(close.keys.map((key) => key.pubkey.toBase58())).toEqual(round3.closeBetting.accounts);
    expect(config.toBase58()).toBe(close.keys[0].pubkey.toBase58());
    expect(round.toBase58()).toBe(close.keys[1].pubkey.toBase58());

    const payer = new PublicKey(round3.startRound.accounts[2]);
    const start = startRoundIx(
      CRASH_PROGRAM_ID,
      payer,
      3n,
      { randomness, oracle, queue, switchboardProgram: SWITCHBOARD_PROGRAM_ID, ...revealSideAccounts(randomness, oracle) },
      { signature: new Uint8Array(64), recoveryId: 0, value: new Uint8Array(32) },
    );
    expect(start.keys.map((key) => key.pubkey.toBase58())).toEqual(round3.startRound.accounts);
  });
});

describe("gateway", () => {
  const randomness = new PublicKey(devnet.randomness.address);

  it("sends the public devnet RPC and the hex randomness key", () => {
    const body = JSON.parse(revealRequestBody({ randomness, seedSlothash: new Uint8Array(32).fill(7), seedSlot: 42n }));
    expect(body).toEqual({
      slothash: new Array(32).fill(7),
      randomness_key: Buffer.from(randomness.toBytes()).toString("hex"),
      slot: 42,
      rpc: "https://api.devnet.solana.com",
    });
  });

  it("parses a well-formed payload and rejects malformed ones", () => {
    const signature = Buffer.alloc(64, 1).toString("base64");
    const value = new Array(32).fill(9);
    expect(parseRevealResponse(JSON.stringify({ signature, recovery_id: 1, value }))).toEqual({
      signature: new Uint8Array(64).fill(1),
      recoveryId: 1,
      value: new Uint8Array(32).fill(9),
    });
    expect(() => parseRevealResponse("<html>")).toThrow(/JSON/);
    expect(() => parseRevealResponse(JSON.stringify({ signature, recovery_id: 4, value }))).toThrow(/recovery_id/);
    expect(() => parseRevealResponse(JSON.stringify({ signature: "AA==", recovery_id: 0, value }))).toThrow(/signature/);
    expect(() => parseRevealResponse(JSON.stringify({ signature, recovery_id: 0, value: [1, 2] }))).toThrow(/value/);
  });

  it("posts to the oracle gateway over https only", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ signature: Buffer.alloc(64).toString("base64"), recovery_id: 0, value: new Array(32).fill(0) }),
    }));
    const request = { randomness, seedSlothash: new Uint8Array(32), seedSlot: 1n };
    await fetchRevealPayload("https://oracle.example/devnet/", request, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://oracle.example/devnet/gateway/api/v1/randomness_reveal",
      expect.objectContaining({ method: "POST" }),
    );
    await expect(fetchRevealPayload("http://oracle.example", request, fetchImpl)).rejects.toThrow(/https/);
    const failing = vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }));
    await expect(fetchRevealPayload("https://oracle.example", request, failing)).rejects.toThrow(/HTTP 500/);
  });
});
