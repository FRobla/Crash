import { PublicKey } from "@solana/web3.js";
import { BorshReader, decodeDefined } from "./borsh";
import { CRASH_IDL_TYPES, idlAccountDiscriminator, idlTypeDef } from "./idl";

/** Typed views of the program accounts (spec v1.1 §2, spec v2 §3). Amounts in lamports. */

export type RoundPhase =
  | "Betting"
  | "AwaitingEntropy"
  | "Running"
  | "Crashed"
  | "Settled"
  | "Voided"
  | "Forfeited";

export interface Limits {
  minStake: bigint;
  maxStake: bigint;
  maxPayout: bigint;
  maxRoundExposure: bigint;
}

export interface Timeouts {
  bettingSlots: bigint;
  entropyTimeoutSlots: bigint;
  revealGraceSlots: bigint;
}

export interface PlayerPolicy {
  maxSessionSlots: bigint;
  usernameCooldownSlots: bigint;
}

export interface HouseConfigAccount {
  admin: PublicKey;
  operator: PublicKey;
  rulesVersion: number;
  limits: Limits;
  maxBetsPerRound: number;
  timeouts: Timeouts;
  playerPolicy: PlayerPolicy;
  paused: boolean;
  nextRoundId: bigint;
  currentRound: bigint | null;
  randomnessAccount: PublicKey;
  bump: number;
  vaultBump: number;
  randomnessAuthorityBump: number;
}

export interface HouseVaultAccount {
  reservedExposure: bigint;
  bump: number;
}

export interface RoundAccount {
  roundId: bigint;
  rulesVersion: number;
  phase: RoundPhase;
  commit: Uint8Array;
  openedSlot: bigint;
  bettingEndSlot: bigint;
  entropyDeadlineSlot: bigint;
  randomnessAccount: PublicKey;
  randomnessSeedSlot: bigint;
  startSlot: bigint;
  revealDeadlineSlot: bigint;
  vrfOutput: Uint8Array;
  seed: Uint8Array;
  crashPoint: bigint;
  crashTick: bigint;
  totalExposure: bigint;
  betCount: number;
  settledCount: number;
  bump: number;
}

export interface ActiveBet {
  roundId: bigint;
  stake: bigint;
  /** Ten-thousandths; 0 = no auto cash-out. */
  autoCashOut: bigint;
  exposure: bigint;
  cashOutTick: bigint | null;
}

export interface Session {
  key: PublicKey;
  expiresSlot: bigint;
  spendCap: bigint;
  spent: bigint;
}

export interface PlayerAccount {
  owner: PublicKey;
  /** `null` after an admin reset (spec v2 §3.3). */
  username: string | null;
  usernameChangedSlot: bigint;
  balance: bigint;
  activeBet: ActiveBet | null;
  session: Session | null;
  totalWagered: bigint;
  betsSettled: bigint;
  createdSlot: bigint;
  bump: number;
}

export interface UsernameRecordAccount {
  owner: PublicKey;
  bump: number;
}

/** Byte offsets inside `Player` used for `getProgramAccounts` filters (spec crash-client-v1 §4.2). */
export const PLAYER_ACTIVE_BET_TAG_OFFSET = 73;
export const PLAYER_ACTIVE_BET_ROUND_ID_OFFSET = 74;

export interface AccountData {
  owner: PublicKey;
  data: Uint8Array;
}

function decodeAccount(name: string, account: AccountData, programId: PublicKey): unknown {
  if (!account.owner.equals(programId)) {
    throw new Error(`${name}: account is not owned by the crash program`);
  }
  const discriminator = idlAccountDiscriminator(name);
  const data = account.data;
  if (data.length < discriminator.length || !discriminator.every((byte, i) => data[i] === byte)) {
    throw new Error(`${name}: discriminator mismatch`);
  }
  // Anchor accounts may carry trailing zero padding; the reader simply stops after the fields.
  return decodeDefined(new BorshReader(data.subarray(discriminator.length)), idlTypeDef(name), CRASH_IDL_TYPES);
}

export function decodeHouseConfig(account: AccountData, programId: PublicKey): HouseConfigAccount {
  return decodeAccount("HouseConfig", account, programId) as HouseConfigAccount;
}

export function decodeHouseVault(account: AccountData, programId: PublicKey): HouseVaultAccount {
  return decodeAccount("HouseVault", account, programId) as HouseVaultAccount;
}

export function decodeRound(account: AccountData, programId: PublicKey): RoundAccount {
  return decodeAccount("Round", account, programId) as RoundAccount;
}

export function decodeUsernameRecord(account: AccountData, programId: PublicKey): UsernameRecordAccount {
  return decodeAccount("UsernameRecord", account, programId) as UsernameRecordAccount;
}

export function decodePlayer(account: AccountData, programId: PublicKey): PlayerAccount {
  const raw = decodeAccount("Player", account, programId) as Omit<PlayerAccount, "username"> & {
    username: { len: number; bytes: Uint8Array };
  };
  const { len, bytes } = raw.username;
  if (len > bytes.length) throw new Error("Player: invalid username length");
  const username = len === 0 ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, len));
  return { ...raw, username };
}

/** A round whose phase no longer changes except `Crashed → Settled` through settlements. */
export function isTerminalPhase(phase: RoundPhase): boolean {
  return phase === "Crashed" || phase === "Settled" || phase === "Voided" || phase === "Forfeited";
}
