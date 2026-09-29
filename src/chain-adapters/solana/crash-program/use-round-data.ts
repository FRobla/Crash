"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { decodeRound } from "./accounts";
import { CRASH_PROGRAM_ID } from "./deployment";
import { fetchSettledBets } from "./bet-history";
import { roundAddress } from "./pdas";
import { roundEvidence } from "./round-evidence";
import { livePhase } from "./view-mapping";

/**
 * Read-only projections for History and Fairness (docs/specs/crash-client-v1.md §7–8), rebuilt
 * from on-chain accounts and events on each load. No cache: a failed RPC call is reported, never
 * shown as a complete (empty) history.
 */

const PID = CRASH_PROGRAM_ID;

export type Loadable<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

export function useRoundEvidence(roundId: bigint | null) {
  const { connection } = useConnection();
  // Results are keyed by round id, so a new request never shows the previous round's data.
  const [state, setState] = useState<{
    roundId: bigint;
    value: Loadable<{ evidence: ReturnType<typeof roundEvidence>; phase: string; randomnessAccount: string; seedSlot: bigint } | null>;
  } | null>(null);

  useEffect(() => {
    if (roundId === null) return;
    let cancelled = false;
    const set = (value: NonNullable<typeof state>["value"]) => !cancelled && setState({ roundId, value });
    connection
      .getAccountInfo(roundAddress(PID, roundId), "confirmed")
      .then((info) => {
        if (!info) return set({ status: "ready", data: null });
        const round = decodeRound(info, PID);
        set({
          status: "ready",
          data: {
            evidence: roundEvidence(round),
            phase: livePhase(round.phase),
            randomnessAccount: round.randomnessAccount.toBase58(),
            seedSlot: round.randomnessSeedSlot,
          },
        });
      })
      .catch(() => set({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [connection, roundId]);

  if (roundId === null) return { status: "ready", data: null } as const;
  return state?.roundId === roundId ? state.value : ({ status: "loading" } as const);
}

export interface RoundRow {
  roundId: bigint;
  phase: ReturnType<typeof livePhase>;
  crashPoint: bigint | null;
  betCount: number;
  totalExposure: bigint;
}

export function useRoundHistory(newestRoundId: bigint | null, count = 20) {
  const { connection } = useConnection();
  const [state, setState] = useState<Loadable<RoundRow[]>>({ status: "loading" });

  useEffect(() => {
    if (newestRoundId === null) return;
    let cancelled = false;
    const ids = Array.from({ length: count }, (_, index) => newestRoundId - BigInt(index)).filter((id) => id >= 0n);
    connection
      .getMultipleAccountsInfo(ids.map((id) => roundAddress(PID, id)), "confirmed")
      .then((infos) => {
        if (cancelled) return;
        const rows = infos.flatMap((info) => {
          if (!info) return [];
          const round = decodeRound(info, PID);
          const phase = livePhase(round.phase);
          const revealed = phase === "crashed" || phase === "settled";
          return [
            {
              roundId: round.roundId,
              phase,
              crashPoint: revealed ? round.crashPoint : null,
              betCount: round.betCount,
              totalExposure: round.totalExposure,
            },
          ];
        });
        setState({ status: "ready", data: rows });
      })
      .catch(() => !cancelled && setState({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [connection, newestRoundId, count]);

  return state;
}

export interface SettledBetRow {
  signature: string;
  roundId: bigint;
  stake: bigint;
  autoCashOut: bigint;
  cashOutTick: bigint | null;
  outcome: "cashed-out" | "lost" | "refunded";
  multiplier: bigint;
  payout: bigint;
  blockTime: number | null;
}

const OUTCOMES = { CashedOut: "cashed-out", Lost: "lost", Refunded: "refunded" } as const;

/** The connected player's last settlements, from `BetSettled` events of their `Player` account. */
export function useMyBetHistory(limit = 20, refreshKey: unknown = null) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const owner = connected ? publicKey : null;
  const ownerKey = owner?.toBase58() ?? null;
  const [state, setState] = useState<{ owner: string; value: Loadable<SettledBetRow[]> } | null>(null);

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    (async () => {
      const settled = await fetchSettledBets(connection, owner, limit, PID);
      const rows = settled.map((bet) => ({
        signature: bet.signature,
        roundId: bet.roundId,
        stake: bet.stake,
        autoCashOut: bet.autoCashOut,
        cashOutTick: bet.cashOutTick,
        outcome: OUTCOMES[bet.outcome],
        multiplier: bet.multiplier,
        payout: bet.payout,
        blockTime: bet.blockTime,
      }));
      if (!cancelled) setState({ owner: owner.toBase58(), value: { status: "ready", data: rows } });
    })().catch(() => !cancelled && setState({ owner: owner.toBase58(), value: { status: "error" } }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the owner's address
  }, [connection, ownerKey, limit, refreshKey]);

  if (!ownerKey) return null;
  return state?.owner === ownerKey ? state.value : ({ status: "loading" } as const);
}
