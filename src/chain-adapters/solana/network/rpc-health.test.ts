import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH } from "../config";
import { classifyGenesisHash, classifyRpcError, rateLimitBackoffMs } from "./rpc-health";

describe("classifyGenesisHash", () => {
  it("reports ok for the devnet genesis hash", () => {
    expect(classifyGenesisHash(DEVNET_GENESIS_HASH)).toBe("ok");
  });

  it("reports wrong-network for mainnet-beta", () => {
    expect(classifyGenesisHash("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toBe(
      "wrong-network",
    );
  });
});

describe("classifyRpcError", () => {
  it("tells throttling apart from an unreachable endpoint", () => {
    expect(classifyRpcError(new Error("429 Too Many Requests: rate limited"))).toBe("rate-limited");
    expect(classifyRpcError(new Error("failed to fetch"))).toBe("unreachable");
  });
});

describe("rateLimitBackoffMs", () => {
  it("does not delay before the first 429", () => {
    expect(rateLimitBackoffMs(0)).toBe(0);
  });

  it("doubles from 2 s and caps at 16 s", () => {
    expect([1, 2, 3, 4, 5, 10].map(rateLimitBackoffMs)).toEqual([2_000, 4_000, 8_000, 16_000, 16_000, 16_000]);
  });
});
