import type { PublicKey } from "@solana/web3.js";
import type { PlayerAccount, RoundAccount, RoundPhase } from "./accounts";

/**
 * Maps confirmed program accounts to the chain-agnostic views the game and platform ports expose.
 * The return types are structural: the app composes them into the ports, so this adapter does
 * not import game or platform code.
 */

export type LivePhase = "betting" | "awaiting-entropy" | "running" | "crashed" | "settled" | "voided" | "forfeited";

const PHASES: Record<RoundPhase, LivePhase> = {
  Betting: "betting",
  AwaitingEntropy: "awaiting-entropy",
  Running: "running",
  Crashed: "crashed",
  Settled: "settled",
  Voided: "voided",
  Forfeited: "forfeited",
};

export function livePhase(phase: RoundPhase): LivePhase {
  return PHASES[phase];
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toLiveRound(round: RoundAccount) {
  const phase = livePhase(round.phase);
  const started = phase === "running" || phase === "crashed" || phase === "settled" || phase === "forfeited";
  const revealed = phase === "crashed" || phase === "settled";
  return {
    roundId: round.roundId,
    rulesVersion: round.rulesVersion,
    phase,
    commitHex: toHex(round.commit),
    openedTick: round.openedSlot,
    bettingEndTick: round.bettingEndSlot,
    startTick: started ? round.startSlot : null,
    /** Written by `start_round`; lets the web verify a seed from the live feed (ADR 0004). */
    vrfOutputHex: started ? toHex(round.vrfOutput) : null,
    crashPoint: revealed ? round.crashPoint : null,
    crashTick: revealed ? round.crashTick : null,
    betCount: round.betCount,
  };
}

export function toRoundSummary(round: RoundAccount) {
  const phase = livePhase(round.phase);
  return {
    roundId: round.roundId,
    phase,
    crashPoint: phase === "crashed" || phase === "settled" ? round.crashPoint : null,
    betCount: round.betCount,
  };
}

/** Why a devnet airdrop failed, pointing at the web faucet when the RPC throttles it. */
export function airdropFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate|limit|too many|faucet has run dry|airdrop request limit/i.test(message)) {
    return "the RPC faucet is rate-limited: use faucet.solana.com instead";
  }
  return `airdrop failed (${message.split("\n")[0].slice(0, 120)}); try faucet.solana.com`;
}

/** Two base fees: below this a session key cannot pay for a bet and a settlement. */
export const MIN_SESSION_FEE_LAMPORTS = 10_000n;

export type SessionStatus = "active" | "expired" | "other-device" | "out-of-fees" | "none";

/** `msPerSlot` is the measured slot duration (spec crash-client-v1 §5.1), only for the estimate. */
export function sessionView(
  player: PlayerAccount | null,
  localKey: PublicKey | null,
  slot: bigint | null,
  sessionLamports: bigint | null,
  msPerSlot: number,
) {
  const session = player?.session ?? null;
  if (!session) return { status: "none" as SessionStatus, spendCap: 0n, spent: 0n, expiresInSeconds: null };
  let status: SessionStatus = "active";
  if (!localKey || !localKey.equals(session.key)) status = "other-device";
  else if (slot !== null && slot > session.expiresSlot) status = "expired";
  else if (sessionLamports !== null && sessionLamports < MIN_SESSION_FEE_LAMPORTS) status = "out-of-fees";
  const expiresInSeconds = slot === null ? null : (Number(session.expiresSlot - slot) * msPerSlot) / 1000;
  return { status, spendCap: session.spendCap, spent: session.spent, expiresInSeconds };
}

const SESSION_BLOCKERS: Record<Exclude<SessionStatus, "active">, string> = {
  none: "Open a betting session in the account panel.",
  expired: "Your session expired: renew it in the account panel.",
  "other-device": "Your session lives on another device: open a new one here.",
  "out-of-fees": "The session ran out of fee budget: renew it.",
};

export function playerBlocker(
  walletConnected: boolean,
  player: PlayerAccount | null | undefined,
  status: SessionStatus,
): string | null {
  if (!walletConnected) return "Connect a wallet to bet.";
  if (player === undefined) return "Loading your account…";
  if (player === null) return "Create an account in the account panel first.";
  return status === "active" ? null : SESSION_BLOCKERS[status];
}
