import type { PublicKey } from "@solana/web3.js";
import { DEFAULT_DEVNET_RPC_URL } from "../config";

/**
 * Switchboard gateway client for the randomness reveal payload (spec crash-client-v1 §4.5), from
 * `Gateway.fetchRandomnessReveal` of `@switchboard-xyz/common` 5.8.5. The payload is public; the
 * program verifies it through Switchboard's CPI, so a lying gateway can only delay the round.
 */

export interface RevealRequest {
  randomness: PublicKey;
  seedSlothash: Uint8Array;
  seedSlot: bigint;
}

export interface RevealPayload {
  signature: Uint8Array;
  recoveryId: number;
  value: Uint8Array;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function revealUrl(gatewayUri: string): string {
  const url = new URL(gatewayUri);
  if (url.protocol !== "https:") throw new Error("Switchboard gateway must use https");
  return `${gatewayUri.replace(/\/+$/, "")}/gateway/api/v1/randomness_reveal`;
}

/** Body sent to the oracle. `rpc` is always the public devnet endpoint, never a keyed RPC URL. */
export function revealRequestBody(request: RevealRequest): string {
  return JSON.stringify({
    slothash: Array.from(request.seedSlothash),
    randomness_key: Array.from(request.randomness.toBytes(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    slot: Number(request.seedSlot),
    rpc: DEFAULT_DEVNET_RPC_URL,
  });
}

function bytesFrom(value: unknown, length: number, field: string): Uint8Array {
  if (typeof value === "string") {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytes.length === length) return bytes;
  } else if (Array.isArray(value) && value.length === length && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error(`Switchboard gateway: invalid ${field}`);
}

export function parseRevealResponse(text: string): RevealPayload {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Switchboard gateway: response is not JSON");
  }
  const record = (json ?? {}) as Record<string, unknown>;
  const recoveryId = record.recovery_id;
  if (typeof recoveryId !== "number" || !Number.isInteger(recoveryId) || recoveryId < 0 || recoveryId > 3) {
    throw new Error("Switchboard gateway: invalid recovery_id");
  }
  return {
    signature: bytesFrom(record.signature, 64, "signature"),
    recoveryId,
    value: bytesFrom(record.value, 32, "value"),
  };
}

export async function fetchRevealPayload(
  gatewayUri: string,
  request: RevealRequest,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<RevealPayload> {
  const response = await fetchImpl(revealUrl(gatewayUri), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: revealRequestBody(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Switchboard gateway: HTTP ${response.status}`);
  return parseRevealResponse(await response.text());
}
