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
