/**
 * Lifecycle of a user action that becomes a transaction (docs/specs/crash-client-v1.md §6.4).
 * Balances and bets on screen never come from this state: they come from confirmed accounts.
 */
export type ActionState =
  | { status: "idle" }
  | { status: "pending"; label: string; step: "signing" | "sending" | "confirming" }
  | { status: "confirmed"; label: string; signature: string }
  | { status: "rejected"; label: string; reason: string };

export const IDLE_ACTION: ActionState = { status: "idle" };

export function isBusy(action: ActionState): boolean {
  return action.status === "pending";
}
