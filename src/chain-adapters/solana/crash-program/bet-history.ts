import type { Connection, PublicKey } from "@solana/web3.js";
import { CRASH_PROGRAM_ID } from "./deployment";
import { betSettledEvents, type BetSettledEvent } from "./events";
import { playerAddress } from "./pdas";

/**
 * A player's settlements rebuilt from `BetSettled` events on their `Player` account (spec
 * crash-client-v1 §7). Transactions are fetched one by one, with retries: public RPCs reject the
 * batched form under their rate limits.
 */

export interface SettledBet extends BetSettledEvent {
  signature: string;
  blockTime: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

export async function fetchSettledBets(
  connection: Connection,
  owner: PublicKey,
  limit: number,
  programId: PublicKey = CRASH_PROGRAM_ID,
): Promise<SettledBet[]> {
  const signatures = await withRetry(() =>
    connection.getSignaturesForAddress(playerAddress(programId, owner), { limit }, "confirmed"),
  );
  const rows: SettledBet[] = [];
  for (const entry of signatures) {
    if (entry.err !== null) continue;
    const transaction = await withRetry(() =>
      connection.getTransaction(entry.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
    );
    for (const event of betSettledEvents(transaction?.meta?.logMessages ?? [], programId)) {
      if (event.player.equals(owner)) {
        rows.push({ ...event, signature: entry.signature, blockTime: transaction?.blockTime ?? null });
      }
    }
  }
  return rows;
}
