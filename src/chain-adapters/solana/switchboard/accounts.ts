import { PublicKey } from "@solana/web3.js";

/**
 * Off-chain reader of the Switchboard On-Demand accounts the operator crank needs
 * (docs/specs/crash-client-v1.md §4.5). Hand-written, like the on-chain adapter
 * (`programs/solana/programs/crash/src/switchboard.rs`), from the on-chain IDL pinned in
 * `fixtures/switchboard-idl-accounts.json`; `switchboard.test.ts` recomputes every offset from it.
 * All layouts are bytemuck `repr(C)` behind an 8-byte discriminator.
 */

/** Devnet program id; the app targets devnet only. */
export const SWITCHBOARD_PROGRAM_ID = new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const WRAPPED_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const DISCRIMINATORS = {
  randomness: [10, 66, 229, 135, 220, 239, 217, 114],
  queue: [217, 194, 55, 127, 184, 83, 138, 1],
  oracle: [128, 30, 16, 241, 170, 73, 55, 54],
} as const;

/** Byte offsets, discriminator included. */
export const RANDOMNESS_OFFSETS = { authority: 8, queue: 40, seedSlothash: 72, seedSlot: 104, oracle: 112, revealSlot: 144, value: 152 } as const;
export const QUEUE_OFFSETS = { oracleKeys: 1064, oracleKeysCapacity: 78, nodeTimeout: 5176, oracleKeysLen: 5204 } as const;
export const ORACLE_OFFSETS = {
  verificationStatus: 72,
  validUntil: 88,
  queue: 3472,
  lastHeartbeat: 3512,
  gatewayUri: 3584,
  gatewayUriLength: 64,
  isOnQueue: 3656,
} as const;

/** `Quote.verification_status` of an oracle whose enclave was verified. */
export const VERIFIED_STATUS = 4;

export interface AccountData {
  owner: PublicKey;
  data: Uint8Array;
}

export interface RandomnessData {
  authority: PublicKey;
  queue: PublicKey;
  seedSlothash: Uint8Array;
  seedSlot: bigint;
  oracle: PublicKey;
  revealSlot: bigint;
  value: Uint8Array;
}

export interface QueueData {
  oracleKeys: PublicKey[];
  /** Seconds after which an oracle heartbeat is stale. */
  nodeTimeout: bigint;
}

export interface OracleData {
  queue: PublicKey;
  verificationStatus: number;
  validUntil: bigint;
  lastHeartbeat: bigint;
  gatewayUri: string;
  isOnQueue: boolean;
}

function checked(kind: keyof typeof DISCRIMINATORS, account: AccountData, minLength: number): DataView {
  if (!account.owner.equals(SWITCHBOARD_PROGRAM_ID)) throw new Error(`Switchboard ${kind}: wrong owner`);
  const data = account.data;
  if (data.length < minLength) throw new Error(`Switchboard ${kind}: account too short`);
  if (!DISCRIMINATORS[kind].every((byte, index) => data[index] === byte)) {
    throw new Error(`Switchboard ${kind}: discriminator mismatch`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function pubkeyAt(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function parseRandomness(account: AccountData): RandomnessData {
  const view = checked("randomness", account, RANDOMNESS_OFFSETS.value + 32);
  const data = account.data;
  const o = RANDOMNESS_OFFSETS;
  return {
    authority: pubkeyAt(data, o.authority),
    queue: pubkeyAt(data, o.queue),
    seedSlothash: Uint8Array.from(data.subarray(o.seedSlothash, o.seedSlothash + 32)),
    seedSlot: view.getBigUint64(o.seedSlot, true),
    oracle: pubkeyAt(data, o.oracle),
    revealSlot: view.getBigUint64(o.revealSlot, true),
    value: Uint8Array.from(data.subarray(o.value, o.value + 32)),
  };
}

export function parseQueue(account: AccountData): QueueData {
  const view = checked("queue", account, QUEUE_OFFSETS.oracleKeysLen + 4);
  const length = view.getUint32(QUEUE_OFFSETS.oracleKeysLen, true);
  if (length > QUEUE_OFFSETS.oracleKeysCapacity) throw new Error("Switchboard queue: invalid oracle count");
  const oracleKeys = Array.from({ length }, (_, index) =>
    pubkeyAt(account.data, QUEUE_OFFSETS.oracleKeys + 32 * index),
  );
  return { oracleKeys, nodeTimeout: view.getBigInt64(QUEUE_OFFSETS.nodeTimeout, true) };
}

export function parseOracle(account: AccountData): OracleData {
  const view = checked("oracle", account, ORACLE_OFFSETS.isOnQueue + 1);
  const data = account.data;
  const o = ORACLE_OFFSETS;
  const uriBytes = data.subarray(o.gatewayUri, o.gatewayUri + o.gatewayUriLength);
  const end = uriBytes.indexOf(0);
  return {
    queue: pubkeyAt(data, o.queue),
    verificationStatus: data[o.verificationStatus],
    validUntil: view.getBigInt64(o.validUntil, true),
    lastHeartbeat: view.getBigInt64(o.lastHeartbeat, true),
    gatewayUri: new TextDecoder().decode(end < 0 ? uriBytes : uriBytes.subarray(0, end)),
    isOnQueue: data[o.isOnQueue] === 1,
  };
}

/** Accounts Switchboard's `randomness_reveal` needs besides the randomness account itself. */
export function revealSideAccounts(randomness: PublicKey, oracle: PublicKey) {
  const encoder = new TextEncoder();
  return {
    stats: PublicKey.findProgramAddressSync([encoder.encode("OracleRandomnessStats"), oracle.toBytes()], SWITCHBOARD_PROGRAM_ID)[0],
    programState: PublicKey.findProgramAddressSync([encoder.encode("STATE")], SWITCHBOARD_PROGRAM_ID)[0],
    rewardEscrow: PublicKey.findProgramAddressSync(
      [randomness.toBytes(), TOKEN_PROGRAM_ID.toBytes(), WRAPPED_SOL_MINT.toBytes()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0],
  };
}
