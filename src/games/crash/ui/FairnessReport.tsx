"use client";

import { useEffect, useState } from "react";
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
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div role="status" aria-live="polite">
        {result === null && <p className="text-muted">Verifying…</p>}
        {result?.status === "verified" && (
          <p className="text-accent">
            Verified: round #{evidence.roundId.toString()} crashed at {formatMultiplier(evidence.crashPoint)}, exactly
            as its pre-committed seed and the randomness determine.
          </p>
        )}
        {result?.status === "mismatch" && (
          <p className="text-danger">Verification FAILED: the recorded result does not match the committed inputs.</p>
        )}
        {result?.status === "unverifiable" && <p className="text-warn">{UNVERIFIABLE[result.reason]}</p>}
      </div>

      {result && result.status !== "unverifiable" && (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Verification checks</caption>
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2 font-normal">Check</th>
              <th className="py-1 pr-2 font-normal">Recorded</th>
              <th className="py-1 pr-2 font-normal">Recomputed</th>
              <th className="py-1 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {result.checks.map((check) => (
              <tr key={check.name} className="border-t border-border align-top">
                <td className="py-1 pr-2">{CHECK_LABEL[check.name]}</td>
                <td className="py-1 pr-2 tabular-nums break-all">{formatCheck(check.name, check.expected)}</td>
                <td className="py-1 pr-2 tabular-nums break-all">{formatCheck(check.name, check.actual)}</td>
                <td className={`py-1 ${check.ok ? "text-accent" : "text-danger"}`}>{check.ok ? "match" : "MISMATCH"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
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

      <details className="text-xs text-muted">
        <summary className="cursor-pointer">How to verify it yourself</summary>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums break-all">{value}</dd>
    </>
  );
}
