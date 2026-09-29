import { Check, LoaderCircle, X } from "lucide-react";
import type { ActionState } from "./action-state";

const STEP_LABEL = { signing: "waiting for signature", sending: "sending", confirming: "confirming" } as const;
const STEPS = ["signing", "sending", "confirming"] as const;
const STEP_SHORT = { signing: "sign", sending: "send", confirming: "confirm" } as const;

/** Live status line for the last action: pending, confirmed (with signature) or rejected (with reason). */
export function ActionStatus({ action, explorerUrl }: { action: ActionState; explorerUrl?: (signature: string) => string }) {
  return (
    <div className="flex flex-col gap-2">
      {action.status === "pending" && <StepTrack step={action.step} />}
      <p role="status" aria-live="polite" className="min-h-4 text-xs break-words">
        {action.status === "pending" && (
          <span className="inline-flex items-center gap-1.5 text-warn">
            <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
            <span>
              {action.label}: {STEP_LABEL[action.step]}…
            </span>
          </span>
        )}
        {action.status === "confirmed" && (
          <span key={action.signature} className="inline-flex animate-pop-in items-center gap-1.5 text-accent">
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              {action.label}: confirmed
              {explorerUrl && (
                <>
                  {" · "}
                  <a className="underline hover:no-underline" href={explorerUrl(action.signature)} target="_blank" rel="noreferrer">
                    tx {action.signature.slice(0, 8)}…
                  </a>
                </>
              )}
            </span>
          </span>
        )}
        {action.status === "rejected" && (
          <span className="inline-flex animate-shake items-start gap-1.5 text-danger">
            <X aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>
              {action.label}: rejected — {action.reason}
            </span>
          </span>
        )}
      </p>
    </div>
  );
}

/** Visual progress through sign → send → confirm; the status line carries the same text. */
function StepTrack({ step }: { step: (typeof STEPS)[number] }) {
  const current = STEPS.indexOf(step);
  return (
    <ol aria-hidden="true" className="flex items-center gap-1 text-[10px] uppercase tracking-wider">
      {STEPS.map((name, index) => (
        <li key={name} className="flex flex-1 flex-col gap-1">
          <span
            className={`h-1 rounded-full transition-colors duration-300 ${
              index < current ? "bg-warn/70" : index === current ? "animate-live-dot bg-warn" : "bg-border"
            }`}
          />
          <span className={index <= current ? "text-warn" : "text-muted/60"}>{STEP_SHORT[name]}</span>
        </li>
      ))}
    </ol>
  );
}
