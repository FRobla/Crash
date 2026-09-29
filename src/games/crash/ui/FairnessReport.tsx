"use client";

import { Check, LoaderCircle, ShieldAlert, ShieldCheck, ShieldX, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { COMMIT_TAG, ENTROPY_TAG, toHex, verifyRound, type RoundEvidence, type Verification } from "../fairness/verify-round";
import { formatMultiplier } from "./multiplier-text";

const UNVERIFIABLE: Record<string, string> = {
  pending: "This round has not been revealed yet: its seed is still secret. Come back when it ends.",
  voided: "Voided before it started: nobody could know the outcome and every stake was refunded. There is no result to verify.",
  forfeited:
    "Not revealed in time: the seed was never published, so the result cannot be verified. Bets were settled with the forfeit rule (as if the round reached the maximum multiplier, refunding losers).",
  "unknown-rules": "This round uses a rules version this verifier does not know.",
  malformed: "The round data is malformed and cannot be verified.",
};

const CHECK_LABEL = {
  commitment: "Commitment matches the revealed seed",
  "crash-point": "Crash point derived from the entropy",
  "crash-tick": "Crash tick on the multiplier curve",
} as const;

function formatCheck(name: keyof typeof CHECK_LABEL, value: string): string {
  if (name === "crash-point") return formatMultiplier(BigInt(value));
  if (name === "commitment") return `${value.slice(0, 16)}…`;
  return value;
}

interface FairnessReportProps {
  evidence: RoundEvidence;
  /** Chain-specific context shown verbatim (e.g. program id, randomness account). */
  details: readonly { label: string; value: string }[];
}

/**
 * Recomputes a round's commitment and crash point in the browser with the published rules
 * (spec crash-client-v1 §8) and shows every input and check.
 */
export function FairnessReport({ evidence, details }: FairnessReportProps) {
  // Keyed by the evidence object, so a new round never shows the previous verdict.
  const [verdict, setVerdict] = useState<{ evidence: RoundEvidence; result: Verification } | null>(null);
  const result = verdict?.evidence === evidence ? verdict.result : null;

  useEffect(() => {
    let cancelled = false;
    verifyRound(evidence).then((verification) => !cancelled && setVerdict({ evidence, result: verification }));
    return () => {
      cancelled = true;
    };
  }, [evidence]);

  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      <div role="status" aria-live="polite">
        {result === null && (
          <Banner tone="border-border bg-surface-raised/40 text-muted" icon={<LoaderCircle className="size-6 animate-spin" />}>
            <p>Verifying…</p>
          </Banner>
        )}
        {result?.status === "verified" && (
          <Banner tone="border-accent/40 bg-accent/10 text-accent" icon={<ShieldCheck className="size-7" />}>
            <p>
              Verified: round #{evidence.roundId.toString()} crashed at {formatMultiplier(evidence.crashPoint)}, exactly
              as its pre-committed seed and the randomness determine.
            </p>
          </Banner>
        )}
        {result?.status === "mismatch" && (
          <Banner tone="border-danger/50 bg-danger/10 text-danger" icon={<ShieldX className="size-7" />}>
            <p>Verification FAILED: the recorded result does not match the committed inputs.</p>
          </Banner>
        )}
        {result?.status === "unverifiable" && (
          <Banner tone="border-warn/40 bg-warn/10 text-warn" icon={<ShieldAlert className="size-7" />}>
            <p>{UNVERIFIABLE[result.reason]}</p>
          </Banner>
        )}
      </div>

      {result && result.status !== "unverifiable" && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Verification checks</caption>
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-3 font-normal uppercase tracking-widest">Check</th>
                <th className="py-2 pr-3 font-normal uppercase tracking-widest">Recorded</th>
                <th className="py-2 pr-3 font-normal uppercase tracking-widest">Recomputed</th>
                <th className="py-2 font-normal uppercase tracking-widest">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.checks.map((check, index) => (
                <tr
                  key={check.name}
                  className="animate-rise-in border-t border-border align-top"
                  style={{ animationDelay: `${index * 120}ms` }}
                >
                  <td className="py-2 pr-3">
                    <span className="mr-2 text-muted">{index + 1}.</span>
                    {CHECK_LABEL[check.name]}
                  </td>
                  <td className="py-2 pr-3 tabular-nums break-all">{formatCheck(check.name, check.expected)}</td>
                  <td className="py-2 pr-3 tabular-nums break-all">{formatCheck(check.name, check.actual)}</td>
                  <td className="py-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px ${
                        check.ok ? "border-accent/30 bg-accent/10 text-accent" : "border-danger/40 bg-danger/10 text-danger"
                      }`}
                    >
                      {check.ok ? <Check aria-hidden="true" className="size-3" /> : <X aria-hidden="true" className="size-3" />}
                      {check.ok ? "match" : "MISMATCH"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-label="Round data" className="rounded-md border border-border bg-bg/60 p-3">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
          {details.map((detail) => (
            <Row key={detail.label} label={detail.label} value={detail.value} />
          ))}
          <Row label="round id" value={evidence.roundId.toString()} />
          <Row label="rules version" value={String(evidence.rulesVersion)} />
          <Row label="commit" value={toHex(evidence.commit)} />
          {evidence.outcome === "revealed" && (
            <>
              <Row label="seed (revealed)" value={toHex(evidence.seed)} />
              <Row label="randomness (VRF output)" value={toHex(evidence.vrfOutput)} />
            </>
          )}
          {result && result.status !== "unverifiable" && <Row label="entropy" value={toHex(result.entropy)} />}
        </dl>
      </section>

      <details className="group rounded-md border border-border px-3 py-2 text-xs text-muted open:bg-surface-raised/30">
        <summary className="cursor-pointer select-none text-fg/80 hover:text-fg">How to verify it yourself</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            commit = SHA-256(&quot;{COMMIT_TAG}&quot; ‖ program id (32 bytes) ‖ round id (u64 little-endian) ‖ seed) must
            equal the commit published when the round opened.
          </li>
          <li>
            entropy = SHA-256(&quot;{ENTROPY_TAG}&quot; ‖ program id ‖ round id ‖ seed ‖ randomness).
          </li>
          <li>
            u = first 52 bits of the entropy (big-endian); crash point in hundredths = ⌊100·(1 − edge)·2⁵² / (2⁵² −
            u)⌋, at least 1.00x and at most the maximum (rules §5 in docs/specs/crash-round-rules.md).
          </li>
          <li>
            Limitation: this page trusts the randomness recorded by the program. The program verified the
            oracle&apos;s signature when the round started (ADR 0002), which is not a mathematical VRF proof.
          </li>
        </ol>
      </details>
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex animate-pop-in items-center gap-3 rounded-md border px-4 py-3 ${tone}`}>
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums break-all">{value}</dd>
    </>
  );
}
