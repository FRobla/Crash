import { z } from "zod";

/**
 * The only supported cluster. Moving to mainnet-beta is a deliberate code change that
 * requires the legal, risk and security review described in CLAUDE.md; it is not configurable.
 */
export const SOLANA_CLUSTER = "devnet" as const;

/** Public devnet endpoint (same value as `clusterApiUrl("devnet")`). */
export const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";

/** Genesis hash of Solana devnet, used to detect RPC endpoints that serve another cluster. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const rpcUrlSchema = z.url({
  protocol: /^https$/,
  error: "NEXT_PUBLIC_SOLANA_RPC_URL must be a valid https URL",
});

export interface SolanaConfig {
  cluster: typeof SOLANA_CLUSTER;
  rpcUrl: string;
  /** Host only, safe to display: paths and query strings may carry provider API keys. */
  rpcHost: string;
}

export interface SolanaPublicEnv {
  NEXT_PUBLIC_SOLANA_RPC_URL?: string;
}

export function parseSolanaConfig(env: SolanaPublicEnv): SolanaConfig {
  const configuredUrl = env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  let rpcUrl = DEFAULT_DEVNET_RPC_URL;

  if (configuredUrl) {
    const result = rpcUrlSchema.safeParse(configuredUrl);
    if (!result.success) {
      // The error message never echoes the configured value.
      throw new Error(`Invalid Solana configuration: ${z.prettifyError(result.error)}`);
    }
    rpcUrl = result.data;
  }

  return { cluster: SOLANA_CLUSTER, rpcUrl, rpcHost: new URL(rpcUrl).host };
}

// NEXT_PUBLIC_* values are inlined at build time, so each one must be referenced literally.
export const solanaConfig = parseSolanaConfig({
  NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
});
