import { DEVNET_GENESIS_HASH } from "../config";

export type RpcHealth = "checking" | "ok" | "wrong-network" | "unreachable";

export const RPC_HEALTH_CHECK_INTERVAL_MS = 30_000;

/** An endpoint is healthy only if it answers and serves devnet, whatever its URL claims. */
export function classifyGenesisHash(genesisHash: string): RpcHealth {
  return genesisHash === DEVNET_GENESIS_HASH ? "ok" : "wrong-network";
}
