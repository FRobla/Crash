import { Buffer } from "buffer";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { Limits, PlayerPolicy, Timeouts } from "./accounts";
import { BorshWriter, encodeType, snakeToCamel } from "./borsh";
import { CRASH_IDL_TYPES, idlInstruction } from "./idl";
import {
  houseConfigAddress,
  houseVaultAddress,
  playerAddress,
  randomnessAuthorityAddress,
  roundAddress,
  usernameRecordAddress,
} from "./pdas";

/**
 * Instruction builders. The account order, signer/writable flags, discriminator and argument
 * layout all come from the IDL (docs/specs/crash-client-v1.md §3); the typed wrappers only derive
 * PDAs so callers cannot pass the wrong one.
 */

/** Builds any program instruction from camelCase account names and arguments. */
export function buildInstruction(
  programId: PublicKey,
  name: string,
  accounts: Record<string, PublicKey | undefined>,
  args: Record<string, unknown> = {},
): TransactionInstruction {
  const spec = idlInstruction(name);
  const keys = spec.accounts.map((account) => {
    const key = accounts[snakeToCamel(account.name)] ?? (account.address ? new PublicKey(account.address) : undefined);
    if (key) return { pubkey: key, isSigner: account.signer === true, isWritable: account.writable === true };
    // Anchor encodes a missing optional account as the program id.
    if (account.optional) return { pubkey: programId, isSigner: false, isWritable: false };
    throw new Error(`${name}: missing account ${account.name}`);
  });
  const writer = new BorshWriter();
  writer.bytes(Uint8Array.from(spec.discriminator));
  for (const arg of spec.args) {
    const camel = snakeToCamel(arg.name);
    if (!(camel in args)) throw new Error(`${name}: missing argument ${arg.name}`);
    encodeType(writer, arg.type, args[camel], CRASH_IDL_TYPES);
  }
  const extra = Object.keys(args).filter((key) => !spec.args.some((arg) => snakeToCamel(arg.name) === key));
  if (extra.length > 0) throw new Error(`${name}: unexpected arguments ${extra.join(", ")}`);
  return new TransactionInstruction({ programId, keys, data: Buffer.from(writer.toBytes()) });
}

// ---- Player (spec v2 §5.1–5.2) ----

export function registerPlayerIx(programId: PublicKey, owner: PublicKey, username: string) {
  return buildInstruction(
    programId,
    "register_player",
    {
      owner,
      config: houseConfigAddress(programId),
      player: playerAddress(programId, owner),
      usernameRecord: usernameRecordAddress(programId, username),
    },
    { username },
  );
}

export function buyCoinsIx(programId: PublicKey, owner: PublicKey, amount: bigint) {
  return buildInstruction(
    programId,
    "buy_coins",
    { owner, config: houseConfigAddress(programId), player: playerAddress(programId, owner) },
    { amount },
  );
}

export function sellCoinsIx(programId: PublicKey, owner: PublicKey, amount: bigint) {
  return buildInstruction(programId, "sell_coins", { owner, player: playerAddress(programId, owner) }, { amount });
}

export interface CreateSessionArgs {
  expiresSlot: bigint;
  spendCap: bigint;
  feeBudget: bigint;
}

export function createSessionIx(programId: PublicKey, owner: PublicKey, sessionKey: PublicKey, args: CreateSessionArgs) {
  return buildInstruction(
    programId,
    "create_session",
    {
      owner,
      config: houseConfigAddress(programId),
      player: playerAddress(programId, owner),
      sessionKey,
    },
    { ...args },
  );
}

/** `signer` is the owner or the current session key. */
export function revokeSessionIx(programId: PublicKey, owner: PublicKey, signer: PublicKey) {
  return buildInstruction(programId, "revoke_session", { signer, player: playerAddress(programId, owner) });
}

export interface PlaceBetArgs {
  roundId: bigint;
  stake: bigint;
  /** Ten-thousandths; 0 = no auto cash-out. */
  autoCashOut: bigint;
}

/** `signer` is the owner or the current session key. */
export function placeBetIx(programId: PublicKey, owner: PublicKey, signer: PublicKey, args: PlaceBetArgs) {
  return buildInstruction(
    programId,
    "place_bet",
    {
      signer,
      config: houseConfigAddress(programId),
      vault: houseVaultAddress(programId),
      round: roundAddress(programId, args.roundId),
      player: playerAddress(programId, owner),
    },
    { ...args },
  );
}

export function cashOutIx(programId: PublicKey, owner: PublicKey, signer: PublicKey, roundId: bigint) {
  return buildInstruction(programId, "cash_out", {
    signer,
    round: roundAddress(programId, roundId),
    player: playerAddress(programId, owner),
  });
}

/** Permissionless: pays the bet of `owner` in `roundId` into its `Player` account. */
export function settleBetIx(programId: PublicKey, owner: PublicKey, roundId: bigint) {
  return buildInstruction(programId, "settle_bet", {
    round: roundAddress(programId, roundId),
    vault: houseVaultAddress(programId),
    player: playerAddress(programId, owner),
  });
}

// ---- Admin (spec v1.1 §4) ----

export interface UpdateConfigArgs {
  operator: PublicKey;
  limits: Limits;
  timeouts: Timeouts;
  maxBetsPerRound: number;
  paused: boolean;
  playerPolicy: PlayerPolicy;
}

/** Replaces every configurable field at once: callers copy the current values they keep. */
export function updateConfigIx(programId: PublicKey, admin: PublicKey, args: UpdateConfigArgs) {
  return buildInstruction(programId, "update_config", { admin, config: houseConfigAddress(programId) }, { ...args });
}

// ---- Rounds (spec v1.1 §4, driven by the operator crank) ----

export function openRoundIx(programId: PublicKey, operator: PublicKey, nextRoundId: bigint, commit: Uint8Array) {
  return buildInstruction(
    programId,
    "open_round",
    { operator, config: houseConfigAddress(programId), round: roundAddress(programId, nextRoundId) },
    { commit },
  );
}

export interface SwitchboardCommitAccounts {
  randomness: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  switchboardProgram: PublicKey;
}

export function closeBettingIx(programId: PublicKey, roundId: bigint, accounts: SwitchboardCommitAccounts) {
  return buildInstruction(programId, "close_betting", {
    config: houseConfigAddress(programId),
    round: roundAddress(programId, roundId),
    randomnessAuthority: randomnessAuthorityAddress(programId),
    ...accounts,
  });
}

export interface SwitchboardRevealAccounts {
  randomness: PublicKey;
  oracle: PublicKey;
  queue: PublicKey;
  stats: PublicKey;
  rewardEscrow: PublicKey;
  programState: PublicKey;
  switchboardProgram: PublicKey;
}

export interface RevealPayload {
  signature: Uint8Array;
  recoveryId: number;
  value: Uint8Array;
}

export function startRoundIx(
  programId: PublicKey,
  payer: PublicKey,
  roundId: bigint,
  accounts: SwitchboardRevealAccounts,
  payload: RevealPayload,
) {
  return buildInstruction(
    programId,
    "start_round",
    {
      config: houseConfigAddress(programId),
      round: roundAddress(programId, roundId),
      payer,
      randomnessAuthority: randomnessAuthorityAddress(programId),
      systemProgram: SystemProgram.programId,
      ...accounts,
    },
    { signature: payload.signature, recoveryId: payload.recoveryId, value: payload.value },
  );
}

export function revealIx(programId: PublicKey, roundId: bigint, seed: Uint8Array) {
  return buildInstruction(
    programId,
    "reveal",
    { config: houseConfigAddress(programId), round: roundAddress(programId, roundId) },
    { seed },
  );
}

/** Operator before the timeout, anyone after it (spec v1.1 §4). */
export function voidRoundIx(programId: PublicKey, authority: PublicKey, roundId: bigint) {
  return buildInstruction(programId, "void_round", {
    authority,
    config: houseConfigAddress(programId),
    round: roundAddress(programId, roundId),
  });
}

export function forfeitRoundIx(programId: PublicKey, roundId: bigint) {
  return buildInstruction(programId, "forfeit_round", {
    config: houseConfigAddress(programId),
    round: roundAddress(programId, roundId),
  });
}
