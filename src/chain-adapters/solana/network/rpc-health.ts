import { DEVNET_GENESIS_HASH } from "../config";

export type RpcHealth = "checking" | "ok" | "wrong-network" | "rate-limited" | "unreachable";

export const RPC_HEALTH_CHECK_INTERVAL_MS = 30_000;

/** An endpoint is healthy only if it answers and serves devnet, whatever its URL claims. */
export function classifyGenesisHash(genesisHash: string): RpcHealth {
  return genesisHash === DEVNET_GENESIS_HASH ? "ok" : "wrong-network";
}

/** A 429 means the endpoint is up but throttling this client (common on the public devnet RPC). */
export function classifyRpcError(error: unknown): RpcHealth {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests/i.test(message) ? "rate-limited" : "unreachable";
}

const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 16_000;

/**
 * Delay before the next poll after `consecutive` rate-limited answers in a row: doubles from 2 s up
 * to 16 s, so a throttled client stops extending its own penalty window. Zero means no backoff.
 */
export function rateLimitBackoffMs(consecutive: number): number {
  if (consecutive <= 0) return 0;
  return Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (consecutive - 1), RATE_LIMIT_BACKOFF_MAX_MS);
}
