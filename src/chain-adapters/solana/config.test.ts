import { describe, expect, it } from "vitest";
import { DEFAULT_DEVNET_RPC_URL, parseSolanaConfig } from "./config";

describe("parseSolanaConfig", () => {
  it("defaults to the public devnet endpoint when no RPC URL is configured", () => {
    expect(parseSolanaConfig({})).toEqual({
      cluster: "devnet",
      rpcUrl: DEFAULT_DEVNET_RPC_URL,
      rpcHost: "api.devnet.solana.com",
    });
  });

  it("treats a blank RPC URL as not configured", () => {
    expect(parseSolanaConfig({ NEXT_PUBLIC_SOLANA_RPC_URL: "  " }).rpcUrl).toBe(
      DEFAULT_DEVNET_RPC_URL,
    );
  });

  it("accepts a custom https endpoint and exposes only its host for display", () => {
    const config = parseSolanaConfig({
      NEXT_PUBLIC_SOLANA_RPC_URL: "https://devnet.rpc.example.com/v1?api-key=secret",
    });

    expect(config.cluster).toBe("devnet");
    expect(config.rpcUrl).toBe("https://devnet.rpc.example.com/v1?api-key=secret");
    expect(config.rpcHost).toBe("devnet.rpc.example.com");
  });

  it.each(["http://api.devnet.solana.com", "wss://api.devnet.solana.com", "not a url"])(
    "rejects %s",
    (value) => {
      expect(() => parseSolanaConfig({ NEXT_PUBLIC_SOLANA_RPC_URL: value })).toThrow(
        /NEXT_PUBLIC_SOLANA_RPC_URL must be a valid https URL/,
      );
    },
  );

  it("does not echo the configured value in the error", () => {
    expect(() =>
      parseSolanaConfig({ NEXT_PUBLIC_SOLANA_RPC_URL: "http://rpc.example.com/?api-key=secret" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret") }));
  });
});
