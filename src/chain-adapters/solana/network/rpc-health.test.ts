import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH } from "../config";
import { classifyGenesisHash, classifyRpcError } from "./rpc-health";

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
