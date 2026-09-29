import type { Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { confirmSignature } from "./send";

type Status = { confirmationStatus: string; err: unknown } | null;

function fakeConnection(recent: Status, history: Status, blockHeight = 200) {
  const getSignatureStatuses = vi.fn(async (_sigs: string[], config?: { searchTransactionHistory?: boolean }) => ({
    context: { slot: 1 },
    value: [config?.searchTransactionHistory ? history : recent],
  }));
  return { connection: { getSignatureStatuses, getBlockHeight: async () => blockHeight } as unknown as Connection, getSignatureStatuses };
}

describe("confirmSignature", () => {
  it("does not report a landed transaction as expired once it left the recent status cache", async () => {
    const { connection, getSignatureStatuses } = fakeConnection(null, { confirmationStatus: "finalized", err: null });
    await expect(confirmSignature(connection, "sig", 100, 1)).resolves.toBeUndefined();
    expect(getSignatureStatuses).toHaveBeenLastCalledWith(["sig"], { searchTransactionHistory: true });
  });

  it("reports expiry only when the history has no trace of it either", async () => {
    const { connection } = fakeConnection(null, null);
    await expect(confirmSignature(connection, "sig", 100, 1)).rejects.toThrow(/expired/);
  });

  it("reports a failed transaction found in the history as failed, not expired", async () => {
    const { connection } = fakeConnection(null, { confirmationStatus: "finalized", err: { InstructionError: [0, { Custom: 6000 }] } });
    await expect(confirmSignature(connection, "sig", 100, 1)).rejects.not.toThrow(/expired/);
  });
});
