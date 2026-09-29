import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_DEVNET_RPC_URL } from "@/chain-adapters/solana/config";

/**
 * Operator crank settings (docs/specs/crash-client-v1.md §4.1, §11). Read from the environment,
 * typically `.env.operator` (git-ignored). Secrets are file paths, never inline values.
 */

export interface OperatorConfig {
  keypairPath: string;
  stateDir: string;
  rpcUrl: string;
  pauseBetweenRoundsMs: number;
  priorityFeeMicroLamports: number;
  pollIntervalMs: number;
}

const schema = z.object({
  CRASH_OPERATOR_KEYPAIR: z.string().min(1, "CRASH_OPERATOR_KEYPAIR is required (path to the operator keypair)"),
  CRASH_OPERATOR_STATE_DIR: z.string().min(1, "CRASH_OPERATOR_STATE_DIR is required (directory for round seeds)"),
  CRASH_OPERATOR_RPC_URL: z.url({ protocol: /^https$/ }).optional(),
  CRASH_OPERATOR_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  CRASH_OPERATOR_PRIORITY_FEE: z.coerce.number().int().min(0).max(1_000_000).default(1_000),
  CRASH_OPERATOR_POLL_MS: z.coerce.number().int().min(200).max(10_000).default(800),
});

/** True when `target` resolves inside `root` (or is `root`). */
export function isInside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function parseOperatorConfig(env: Record<string, string | undefined>, repoRoot: string): OperatorConfig {
  const result = schema.safeParse(env);
  // The message lists what is wrong, never the values.
  if (!result.success) throw new Error(`Invalid operator configuration: ${z.prettifyError(result.error)}`);
  const values = result.data;
  for (const [name, path] of [
    ["CRASH_OPERATOR_KEYPAIR", values.CRASH_OPERATOR_KEYPAIR],
    ["CRASH_OPERATOR_STATE_DIR", values.CRASH_OPERATOR_STATE_DIR],
  ] as const) {
    if (isInside(repoRoot, path)) throw new Error(`${name} must point outside the repository`);
  }
  return {
    keypairPath: values.CRASH_OPERATOR_KEYPAIR,
    stateDir: values.CRASH_OPERATOR_STATE_DIR,
    rpcUrl: values.CRASH_OPERATOR_RPC_URL ?? DEFAULT_DEVNET_RPC_URL,
    pauseBetweenRoundsMs: values.CRASH_OPERATOR_PAUSE_MS,
    priorityFeeMicroLamports: values.CRASH_OPERATOR_PRIORITY_FEE,
    pollIntervalMs: values.CRASH_OPERATOR_POLL_MS,
  };
}
