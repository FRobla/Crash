import { SendTransactionError, type Connection, type Transaction } from "@solana/web3.js";
import { describeProgramError } from "./errors";

/**
 * Sending and confirming from the browser. Confirmation polls signature statuses instead of relying
 * on a WebSocket, which public RPCs often rate-limit; a transaction whose blockhash expires is
 * reported as expired, never as confirmed.
 */

export class TransactionFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function failureReason(error: unknown): string {
  if (error instanceof TransactionFailed) return error.reason;
  const logs = error instanceof SendTransactionError ? error.logs : undefined;
  const programError = describeProgramError(error, logs);
  if (programError) return programError;
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|rejected the request/i.test(message)) return "cancelled in the wallet";
  return message.split("\n")[0].slice(0, 160);
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  pollMs = 1_000,
  maxConsecutiveRpcErrors = 15,
): Promise<void> {
  let rpcErrors = 0;
  for (;;) {
    let status;
    let expired = false;
    try {
      status = (await connection.getSignatureStatuses([signature])).value[0];
      // A transaction already seen by the cluster cannot expire any more; only an unseen one can.
      if (!status) expired = (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
      rpcErrors = 0;
    } catch (error) {
      // Throttling or a dropped request says nothing about the transaction: keep polling.
      rpcErrors += 1;
      if (rpcErrors >= maxConsecutiveRpcErrors) {
        throw new TransactionFailed(`could not confirm (${failureReason(error)}); check its status before retrying`);
      }
    }
    if (status?.err) throw new TransactionFailed(describeProgramError(JSON.stringify(status.err)) ?? "transaction failed");
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return;
    if (expired) throw new TransactionFailed("expired before confirmation; nothing was applied");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Sends an already fully signed transaction (with simulation) and waits for `confirmed`. */
export async function sendSigned(connection: Connection, transaction: Transaction, lastValidBlockHeight: number): Promise<string> {
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
  await confirmSignature(connection, signature, lastValidBlockHeight);
  return signature;
}
