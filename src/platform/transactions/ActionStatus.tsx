import type { ActionState } from "./action-state";

const STEP_LABEL = { signing: "waiting for signature", sending: "sending", confirming: "confirming" } as const;

/** Live status line for the last action: pending, confirmed (with signature) or rejected (with reason). */
export function ActionStatus({ action, explorerUrl }: { action: ActionState; explorerUrl?: (signature: string) => string }) {
  return (
    <p role="status" aria-live="polite" className="min-h-4 text-xs break-words">
      {action.status === "pending" && (
        <span className="text-warn">
          {action.label}: {STEP_LABEL[action.step]}…
        </span>
      )}
      {action.status === "confirmed" && (
        <span className="text-accent">
          {action.label}: confirmed
          {explorerUrl && (
            <>
              {" · "}
              <a className="underline" href={explorerUrl(action.signature)} target="_blank" rel="noreferrer">
                tx {action.signature.slice(0, 8)}…
              </a>
            </>
          )}
        </span>
      )}
      {action.status === "rejected" && (
        <span className="text-danger">
          {action.label}: rejected — {action.reason}
        </span>
      )}
    </p>
  );
}
