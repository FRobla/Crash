import { PublicKey } from "@solana/web3.js";

/** PDA seeds of the crash program (`programs/solana/programs/crash/src/constants.rs`). */

const encoder = new TextEncoder();

function find(programId: PublicKey, seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function houseConfigAddress(programId: PublicKey): PublicKey {
  return find(programId, [encoder.encode("house")]);
}

export function houseVaultAddress(programId: PublicKey): PublicKey {
  return find(programId, [encoder.encode("vault")]);
}

export function roundAddress(programId: PublicKey, roundId: bigint): PublicKey {
  return find(programId, [encoder.encode("round"), u64Le(roundId)]);
}

export function playerAddress(programId: PublicKey, owner: PublicKey): PublicKey {
  return find(programId, [encoder.encode("player"), owner.toBytes()]);
}

export function usernameRecordAddress(programId: PublicKey, username: string): PublicKey {
  return find(programId, [encoder.encode("username"), encoder.encode(username)]);
}

export function randomnessAuthorityAddress(programId: PublicKey): PublicKey {
  return find(programId, [encoder.encode("randomness_authority")]);
}
