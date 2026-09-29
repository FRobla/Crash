"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeHouseConfig,
  decodePlayer,
  decodeRound,
  isTerminalPhase,
  type HouseConfigAccount,
  type PlayerAccount,
  type RoundAccount,
} from "./accounts";
import { CRASH_PROGRAM_ID } from "./deployment";
import {
  buyCoinsIx,
  cashOutIx,
  createSessionIx,
  placeBetIx,
  registerPlayerIx,
  revokeSessionIx,
  sellCoinsIx,
  settleBetIx,
} from "./instructions";
import { houseConfigAddress, playerAddress, roundAddress, usernameRecordAddress } from "./pdas";
import { failureReason, sendSigned } from "./send";
import { browserStorage, clearSessionKey, loadSessionKey, saveSessionKey } from "./session-key-store";
import {
  APPROX_SECONDS_PER_SLOT,
  MIN_SESSION_FEE_LAMPORTS,
  playerBlocker,
  sessionView,
  toLiveRound,
  toRoundSummary,
} from "./view-mapping";

/**
 * Solana implementation of the live game and player account ports (docs/specs/crash-client-v1.md
 * §5–6). State comes from confirmed accounts polled in a single `getMultipleAccounts` call per
 * second; the slot clock is interpolated between polls only for the labeled projection.
 */

const PID = CRASH_PROGRAM_ID;
const POLL_MS = 1_000;
const STALE_AFTER_MS = 5_000;
const RECENT_ROUNDS = 12;
/** Spec v2 §6 UI defaults. */
const SESSION_SLOTS = 216_000n;
const FEE_BUDGET_LAMPORTS = 10_000_000n;
/** Account sizes (spec v2 §3.1); their rent is read from the RPC, this is only a fallback. */
const PLAYER_ACCOUNT_BYTES = 197;
const USERNAME_RECORD_BYTES = 41;
const ACCOUNT_RENT_FALLBACK = 2_600_000n;
const EXPLORER = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

type Action =
  | { status: "idle" }
  | { status: "pending"; label: string; step: "signing" | "sending" | "confirming" }
  | { status: "confirmed"; label: string; signature: string }
  | { status: "rejected"; label: string; reason: string };

interface ChainState {
  /** Wallet the player fields belong to. */
  owner: string | null;
  config: HouseConfigAccount | null;
  /** Newest round (active or last finished). */
  round: RoundAccount | null;
  /** `undefined` while loading, `null` when not registered. */
  player: PlayerAccount | null | undefined;
  walletLamports: bigint | null;
  sessionLamports: bigint | null;
  slot: bigint | null;
  observedAt: number;
  lastSuccessAt: number;
  failed: boolean;
  /** Failing for longer than STALE_AFTER_MS. */
  stale: boolean;
}

const INITIAL: ChainState = {
  owner: null,
  config: null,
  round: null,
  player: undefined,
  walletLamports: null,
  sessionLamports: null,
  slot: null,
  observedAt: 0,
  lastSuccessAt: 0,
  failed: false,
  stale: false,
};

export function useSolanaCrash() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const owner = wallet.connected ? wallet.publicKey : null;
  const ownerKey = owner?.toBase58() ?? null;

  const [state, setState] = useState<ChainState>(INITIAL);
  const [local, setLocal] = useState<{ owner: string | null; key: Keypair | null }>({ owner: null, key: null });
  const [recent, setRecent] = useState<RoundAccount[]>([]);
  const [accountRent, setAccountRent] = useState<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      connection.getMinimumBalanceForRentExemption(PLAYER_ACCOUNT_BYTES),
      connection.getMinimumBalanceForRentExemption(USERNAME_RECORD_BYTES),
    ])
      .then(([player, record]) => !cancelled && setAccountRent(BigInt(player + record)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection]);
  const [action, setAction] = useState<Action>({ status: "idle" });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const pollNow = useRef<() => void>(() => undefined);

  // This device's session key for the connected wallet, reloaded when the wallet changes
  // (adjusting state during render, so no stale key is ever used for another wallet).
  if (local.owner !== ownerKey) {
    setLocal({ owner: ownerKey, key: owner ? loadSessionKey(browserStorage(), PID, owner) : null });
  }
  const sessionKey = local.owner === ownerKey ? local.key : null;
  const setSessionKey = useCallback((key: Keypair | null) => setLocal({ owner: ownerKey, key }), [ownerKey]);
  /** The polled player, only if it belongs to the connected wallet. */
  const currentPlayer = useCallback(
    () => (stateRef.current.owner === ownerKey ? stateRef.current.player : undefined),
    [ownerKey],
  );

  // Poll config, newest round, player, wallet and session key balances in one request.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let roundId: bigint | null = stateRef.current.config ? stateRef.current.config.nextRoundId - 1n : null;

    async function poll() {
      clearTimeout(timer);
      try {
        const keys: PublicKey[] = [houseConfigAddress(PID)];
        const roundIndex = roundId !== null && roundId >= 0n ? keys.push(roundAddress(PID, roundId)) - 1 : -1;
        const playerIndex = owner ? keys.push(playerAddress(PID, owner)) - 1 : -1;
        const walletIndex = owner ? keys.push(owner) - 1 : -1;
        const sessionIndex = sessionKey ? keys.push(sessionKey.publicKey) - 1 : -1;
        const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
        if (cancelled) return;
        if (!value[0]) throw new Error("house config not found");
        const config = decodeHouseConfig(value[0], PID);
        const newest = config.nextRoundId > 0n ? config.nextRoundId - 1n : null;
        const lamports = (index: number) => (index < 0 ? null : BigInt(value[index]?.lamports ?? 0));
        const now = Date.now();
        setState({
          owner: ownerKey,
          config,
          round: roundIndex >= 0 && value[roundIndex] ? decodeRound(value[roundIndex]!, PID) : null,
          player: playerIndex < 0 ? undefined : value[playerIndex] ? decodePlayer(value[playerIndex]!, PID) : null,
          walletLamports: lamports(walletIndex),
          sessionLamports: lamports(sessionIndex),
          slot: BigInt(context.slot),
          observedAt: now,
          lastSuccessAt: now,
          failed: false,
          stale: false,
        });
        if (newest !== roundId) {
          // A new round appeared: fetch it right away instead of waiting a full interval.
          roundId = newest;
          timer = setTimeout(poll, 0);
          return;
        }
      } catch {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            failed: true,
            stale: Date.now() - previous.lastSuccessAt > STALE_AFTER_MS,
          }));
        }
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    pollNow.current = () => void poll();
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- owner is tracked through ownerKey
  }, [connection, ownerKey, sessionKey]);

  // Recent rounds, refreshed whenever a round changes phase or a new one opens.
  const newestId = state.config ? state.config.nextRoundId - 1n : null;
  const newestPhase = state.round?.phase ?? null;
  useEffect(() => {
    if (newestId === null || newestId < 0n) return;
    let cancelled = false;
    const ids = Array.from({ length: RECENT_ROUNDS }, (_, index) => newestId - BigInt(index)).filter((id) => id >= 0n);
    connection
      .getMultipleAccountsInfo(ids.map((id) => roundAddress(PID, id)), "confirmed")
      .then((infos) => {
        if (cancelled) return;
        setRecent(infos.flatMap((info) => (info ? [decodeRound(info, PID)] : [])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, newestId, newestPhase]);

  const estimatedTick = useCallback((): bigint | null => {
    const { slot, observedAt } = stateRef.current;
    if (slot === null) return null;
    return slot + BigInt(Math.floor((Date.now() - observedAt) / (APPROX_SECONDS_PER_SLOT * 1000)));
  }, []);

  // ---- Transactions ----

  const run = useCallback(
    async (
      label: string,
      build: () => Promise<{ instructions: TransactionInstruction[]; payer: "wallet" | "session"; signers: Keypair[] }>,
      after?: () => void,
    ) => {
      try {
        setAction({ status: "pending", label, step: "signing" });
        const { instructions, payer, signers } = await build();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const feePayer = payer === "wallet" ? owner : signers[0]?.publicKey;
        if (!feePayer) throw new Error("no fee payer");
        const transaction = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...instructions);
        if (signers.length > 0) transaction.partialSign(...signers);
        let signed = transaction;
        if (payer === "wallet" || instructions.some((ix) => ix.keys.some((key) => key.isSigner && owner && key.pubkey.equals(owner)))) {
          if (!wallet.signTransaction) throw new Error("this wallet cannot sign transactions");
          signed = await wallet.signTransaction(transaction);
        }
        setAction({ status: "pending", label, step: "confirming" });
        const signature = await sendSigned(connection, signed, lastValidBlockHeight);
        after?.();
        setAction({ status: "confirmed", label, signature });
      } catch (error) {
        setAction({ status: "rejected", label, reason: failureReason(error) });
      } finally {
        pollNow.current();
      }
    },
    [connection, owner, wallet],
  );

  const requireOwner = useCallback(() => {
    if (!owner) throw new Error("connect a wallet first");
    return owner;
  }, [owner]);

  /** Moves every lamport of a local session key back to the owner (requires its signature). */
  const sweep = useCallback(
    (key: Keypair, lamports: bigint | null) =>
      lamports && lamports > 0n
        ? [SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: requireOwner(), lamports })]
        : [],
    [requireOwner],
  );

  const newSession = useCallback(
    async (spendCap: bigint) => {
      const me = requireOwner();
      const key = Keypair.generate();
      // Persist before funding it: a key that cannot be stored must never receive funds.
      if (!saveSessionKey(browserStorage(), PID, me, key)) throw new Error("this browser cannot store the session key");
      const slot = BigInt(await connection.getSlot("confirmed"));
      const ix = createSessionIx(PID, me, key.publicKey, {
        expiresSlot: slot + SESSION_SLOTS,
        spendCap,
        feeBudget: FEE_BUDGET_LAMPORTS,
      });
      return { key, ix };
    },
    [connection, requireOwner],
  );

  const player = state.owner === ownerKey ? state.player : undefined;
  const walletLamports = state.owner === ownerKey ? state.walletLamports : null;
  const session = sessionView(player ?? null, sessionKey?.publicKey ?? null, state.slot, state.sessionLamports);

  const register = useCallback(
    (username: string, coins: bigint) =>
      run("Create account", async () => {
        const me = requireOwner();
        const { key, ix } = await newSession(coins);
        setSessionKey(key);
        return {
          instructions: [registerPlayerIx(PID, me, username), buyCoinsIx(PID, me, coins), ix],
          payer: "wallet",
          signers: [],
        };
      }),
    [newSession, requireOwner, run, setSessionKey],
  );

  const buy = useCallback(
    (coins: bigint) =>
      run("Buy coins", async () => {
        const me = requireOwner();
        const instructions = [buyCoinsIx(PID, me, coins)];
        const current = currentPlayer();
        // Refresh the active session so its cap covers the new balance (same key, spent resets).
        if (sessionKey && current?.session?.key.equals(sessionKey.publicKey)) {
          const slot = BigInt(await connection.getSlot("confirmed"));
          const topUp = (stateRef.current.sessionLamports ?? 0n) < FEE_BUDGET_LAMPORTS / 5n;
          instructions.push(
            createSessionIx(PID, me, sessionKey.publicKey, {
              expiresSlot: slot + SESSION_SLOTS,
              spendCap: current.balance + coins,
              feeBudget: topUp ? FEE_BUDGET_LAMPORTS : 0n,
            }),
          );
        }
        return { instructions, payer: "wallet", signers: [] };
      }),
    [connection, currentPlayer, requireOwner, run, sessionKey],
  );

  const renewSession = useCallback(
    () =>
      run("Open session", async () => {
        const balance = currentPlayer()?.balance ?? 0n;
        if (balance === 0n) throw new Error("buy coins first");
        const previous = sessionKey;
        const previousLamports = stateRef.current.sessionLamports;
        const { key, ix } = await newSession(balance);
        setSessionKey(key);
        const instructions = previous ? [...sweep(previous, previousLamports), ix] : [ix];
        return { instructions, payer: "wallet", signers: previous && previousLamports ? [previous] : [] };
      }),
    [currentPlayer, newSession, run, sessionKey, setSessionKey, sweep],
  );

  const revokeSession = useCallback(
    () =>
      run(
        "Revoke session",
        async () => {
          const me = requireOwner();
          const lamports = stateRef.current.sessionLamports;
          const instructions = [revokeSessionIx(PID, me, me), ...(sessionKey ? sweep(sessionKey, lamports) : [])];
          return { instructions, payer: "wallet", signers: sessionKey && lamports ? [sessionKey] : [] };
        },
        () => {
          if (owner) clearSessionKey(browserStorage(), PID, owner);
          setSessionKey(null);
        },
      ),
    [owner, requireOwner, run, sessionKey, setSessionKey, sweep],
  );

  const exit = useCallback(
    () =>
      run(
        "Sell all & exit",
        async () => {
          const me = requireOwner();
          const current = currentPlayer();
          if (!current) throw new Error("no account");
          if (current.activeBet) throw new Error("wait until your bet is settled");
          const lamports = stateRef.current.sessionLamports;
          const instructions: TransactionInstruction[] = [];
          if (current.session) instructions.push(revokeSessionIx(PID, me, me));
          if (current.balance > 0n) instructions.push(sellCoinsIx(PID, me, current.balance));
          if (sessionKey) instructions.push(...sweep(sessionKey, lamports));
          if (instructions.length === 0) throw new Error("nothing to sell");
          return { instructions, payer: "wallet", signers: sessionKey && lamports ? [sessionKey] : [] };
        },
        () => {
          if (owner) clearSessionKey(browserStorage(), PID, owner);
          setSessionKey(null);
        },
      ),
    [currentPlayer, owner, requireOwner, run, sessionKey, setSessionKey, sweep],
  );

  const checkUsername = useCallback(
    async (username: string) => {
      if (!/^[a-z0-9_]{3,16}$/.test(username)) return "invalid" as const;
      const info = await connection.getAccountInfo(usernameRecordAddress(PID, username), "confirmed");
      return info ? ("taken" as const) : ("available" as const);
    },
    [connection],
  );

  /** Whether the player's current bet belongs to a round that has finished. */
  const activeBetFinished = useCallback(async (): Promise<boolean> => {
    const bet = currentPlayer()?.activeBet;
    if (!bet) return false;
    const known = [stateRef.current.round, ...recent].find((round) => round?.roundId === bet.roundId);
    if (known && isTerminalPhase(known.phase)) return true;
    const info = await connection.getAccountInfo(roundAddress(PID, bet.roundId), "confirmed");
    return info ? isTerminalPhase(decodeRound(info, PID).phase) : false;
  }, [connection, currentPlayer, recent]);

  const placeBet = useCallback(
    (stake: bigint, autoCashOut: bigint) =>
      run("Place bet", async () => {
        const me = requireOwner();
        const round = stateRef.current.round;
        if (!sessionKey) throw new Error("no session on this device");
        if (!round || round.phase !== "Betting") throw new Error("no round is taking bets");
        const instructions: TransactionInstruction[] = [];
        const bet = currentPlayer()?.activeBet;
        if (bet && (await activeBetFinished())) instructions.push(settleBetIx(PID, me, bet.roundId));
        instructions.push(placeBetIx(PID, me, sessionKey.publicKey, { roundId: round.roundId, stake, autoCashOut }));
        return { instructions, payer: "session", signers: [sessionKey] };
      }),
    [activeBetFinished, currentPlayer, requireOwner, run, sessionKey],
  );

  const cashOut = useCallback(
    () =>
      run("Cash out", async () => {
        const me = requireOwner();
        const bet = currentPlayer()?.activeBet;
        if (!sessionKey) throw new Error("no session on this device");
        if (!bet) throw new Error("no bet in play");
        return { instructions: [cashOutIx(PID, me, sessionKey.publicKey, bet.roundId)], payer: "session", signers: [sessionKey] };
      }),
    [currentPlayer, requireOwner, run, sessionKey],
  );

  const settle = useCallback(
    () =>
      run("Settle bet", async () => {
        const me = requireOwner();
        const bet = currentPlayer()?.activeBet;
        if (!bet) throw new Error("no bet to settle");
        const ix = settleBetIx(PID, me, bet.roundId);
        const lamports = stateRef.current.sessionLamports ?? 0n;
        return sessionKey && lamports >= MIN_SESSION_FEE_LAMPORTS
          ? { instructions: [ix], payer: "session", signers: [sessionKey] }
          : { instructions: [ix], payer: "wallet", signers: [] };
      }),
    [currentPlayer, requireOwner, run, sessionKey],
  );

  const connectionStatus: "connecting" | "live" | "stale" =
    state.lastSuccessAt === 0 ? "connecting" : state.stale ? "stale" : "live";
  const walletStatus: "disconnected" | "connecting" | "connected" = wallet.connecting
    ? "connecting"
    : owner
      ? "connected"
      : "disconnected";

  const game = useMemo(
    () => ({
      connection: connectionStatus,
      paused: state.config?.paused ?? false,
      limits: state.config?.limits ?? null,
      round: state.round ? toLiveRound(state.round) : null,
      estimatedTick,
      myBet: player?.activeBet ?? null,
      playerBlocker: playerBlocker(owner !== null, player, session.status),
      balance: player?.balance ?? null,
      recentRounds: recent.filter((round) => isTerminalPhase(round.phase)).map(toRoundSummary),
      action,
      explorerUrl: EXPLORER,
      placeBet,
      cashOut,
      settle,
    }),
    [action, cashOut, connectionStatus, estimatedTick, owner, placeBet, player, recent, session.status, settle, state.config, state.round],
  );

  const account = useMemo(
    () => ({
      wallet: walletStatus,
      status: (!owner
        ? "loading"
        : player === undefined
          ? state.failed
            ? "error"
            : "loading"
          : player === null
            ? "unregistered"
            : "registered") as "loading" | "unregistered" | "registered" | "error",
      username: player?.username ?? null,
      address: ownerKey,
      balance: player?.balance ?? null,
      walletBalance: walletLamports,
      session,
      hasActiveBet: Boolean(player?.activeBet),
      registrationOverhead: (accountRent ?? ACCOUNT_RENT_FALLBACK) + FEE_BUDGET_LAMPORTS,
      action,
      explorerUrl: EXPLORER,
      checkUsername,
      register,
      buy,
      renewSession,
      revokeSession,
      exit,
    }),
    // `session` is rebuilt every render; its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountRent, action, buy, checkUsername, exit, owner, ownerKey, player, register, renewSession, revokeSession, session.status, session.spent, session.spendCap, session.expiresInSeconds, state.failed, walletLamports, walletStatus],
  );

  return { game, account };
}
