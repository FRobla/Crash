import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Durable custody of unrevealed round seeds (docs/specs/crash-client-v1.md §4.4). A seed is written
 * and fsynced before `open_round` is sent, is never overwritten (a late-landing `open_round` must
 * still find the seed it committed to), and is deleted once its reveal is confirmed.
 * Seeds are never logged; errors only mention round ids.
 */

const SEED_BYTES = 32;

export interface SeedStore {
  /** The stored seed for `roundId`, creating one with `generate` if none exists yet. */
  getOrCreate(roundId: bigint, generate: () => Uint8Array): Uint8Array;
  read(roundId: bigint): Uint8Array | null;
  remove(roundId: bigint): void;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows cannot fsync a directory; the file itself is already fsynced.
  }
}

export function createFileSeedStore(directory: string): SeedStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pathFor = (roundId: bigint) => join(directory, `round-${roundId}.seed`);

  const read = (roundId: bigint): Uint8Array | null => {
    let text: string;
    try {
      text = readFileSync(pathFor(roundId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const seed = fromHex(text.trim());
    if (!seed) throw new Error(`seed file for round ${roundId} is corrupt`);
    return seed;
  };

  return {
    read,
    getOrCreate(roundId, generate) {
      const existing = read(roundId);
      if (existing) return existing;
      const seed = generate();
      if (seed.length !== SEED_BYTES) throw new Error("seed must be 32 bytes");
      // `wx` fails if another writer created the file in between: never overwrite a seed.
      const fd = openSync(pathFor(roundId), "wx", 0o600);
      try {
        writeSync(fd, toHex(seed));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(directory);
      return seed;
    },
    remove(roundId) {
      rmSync(pathFor(roundId), { force: true });
    },
  };
}
