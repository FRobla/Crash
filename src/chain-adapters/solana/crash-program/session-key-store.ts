import { Keypair, type PublicKey } from "@solana/web3.js";

/**
 * Browser custody of the player's session key (docs/specs/crash-client-v1.md §6.3; user decision:
 * `localStorage`). The key can only bet up to its spending cap, cash out and revoke itself
 * (spec v2 §4), so a stolen key is bounded by `spend_cap + fee_budget`. It never leaves the browser.
 * Storage can be missing or throw (private mode, blocked site data); every access is guarded.
 */

const PREFIX = "crashit:session:v1:";

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function sessionStorageKey(programId: PublicKey, owner: PublicKey): string {
  return `${PREFIX}${programId.toBase58()}:${owner.toBase58()}`;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function loadSessionKey(storage: KeyValueStorage | null, programId: PublicKey, owner: PublicKey): Keypair | null {
  try {
    const stored = storage?.getItem(sessionStorageKey(programId, owner));
    if (!stored) return null;
    const secret = fromBase64(stored);
    return secret.length === 64 ? Keypair.fromSecretKey(secret) : null;
  } catch {
    return null;
  }
}

/** Returns false if the key could not be stored: the caller must not fund a key it may lose. */
export function saveSessionKey(storage: KeyValueStorage | null, programId: PublicKey, owner: PublicKey, key: Keypair): boolean {
  try {
    if (!storage) return false;
    const name = sessionStorageKey(programId, owner);
    storage.setItem(name, toBase64(key.secretKey));
    return storage.getItem(name) !== null;
  } catch {
    return false;
  }
}

export function clearSessionKey(storage: KeyValueStorage | null, programId: PublicKey, owner: PublicKey): void {
  try {
    storage?.removeItem(sessionStorageKey(programId, owner));
  } catch {
    // Nothing else to do: a leftover key is still bounded by its on-chain limits.
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
