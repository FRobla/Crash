"use client";

import { useEffect, useState } from "react";
import { deriveOutcome, toHex } from "../fairness/verify-round";
import type { CrashGamePort } from "./crash-game";
import type { EarlyCrash } from "./round-view";

/**
 * Verifies the live feed's seed for the running round (ADR 0004; spec crash-client-v1 §5.2): the
 * crash is shown early only if the seed reproduces the round's on-chain commit, and its outcome
 * comes from the shared verifier with the on-chain VRF output. Anything else is ignored.
 */

const HEX_32 = /^[0-9a-f]{64}$/;

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

// Shared by every component on the page, so each seed is hashed once.
const verified = new Map<string, Promise<EarlyCrash | null>>();

export function verifyRevealHint(
  game: Pick<CrashGamePort, "round" | "revealHint" | "programIdHex">,
): { key: string; result: Promise<EarlyCrash | null> } | null {
  const { round, revealHint, programIdHex } = game;
  if (!round || !revealHint || revealHint.roundId !== round.roundId) return null;
  if (round.vrfOutputHex === null || !HEX_32.test(revealHint.seedHex) || !HEX_32.test(round.vrfOutputHex)) return null;
  if (!HEX_32.test(programIdHex) || !HEX_32.test(round.commitHex)) return null;
  const key = [programIdHex, round.roundId, round.rulesVersion, round.commitHex, round.vrfOutputHex, revealHint.seedHex].join(":");
  let result = verified.get(key);
  if (!result) {
    const roundId = round.roundId;
    const commitHex = round.commitHex;
    result = deriveOutcome(fromHex(programIdHex), roundId, round.rulesVersion, fromHex(revealHint.seedHex), fromHex(round.vrfOutputHex))
      .then((outcome) =>
        outcome && toHex(outcome.commitment) === commitHex
          ? { roundId, crashPoint: outcome.crashPoint, crashTick: outcome.crashTick }
          : null,
      )
      .catch(() => null);
    verified.set(key, result);
    if (verified.size > 32) verified.delete(verified.keys().next().value!);
  }
  return { key, result };
}

/** The verified early crash for the current round, or null (none, not verified yet, or invalid). */
export function useEarlyCrash(game: Pick<CrashGamePort, "round" | "revealHint" | "programIdHex">): EarlyCrash | null {
  const [state, setState] = useState<{ key: string; value: EarlyCrash | null } | null>(null);
  const pending = verifyRevealHint(game);
  const key = pending?.key ?? null;

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void pending.result.then((value) => {
      if (!cancelled) setState({ key: pending.key, value });
    });
    return () => {
      cancelled = true;
    };
    // `pending` is rebuilt every render; its key identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state !== null && state.key === key ? state.value : null;
}
