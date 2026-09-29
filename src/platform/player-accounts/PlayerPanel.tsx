"use client";

import { Clock, KeyRound, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Meter } from "@/platform/shell/Meter";
import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import { ActionStatus } from "@/platform/transactions/ActionStatus";
import { isBusy } from "@/platform/transactions/action-state";
import { shortenAddress } from "@/platform/wallets/wallet-session";
import { formatCoins, parseCoins } from "./coins";
import { isValidUsername, usePlayerAccount, type PlayerSessionView } from "./player-account";

const INPUT_CLASS =
  "w-full min-w-0 rounded-md border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg transition-colors placeholder:text-muted hover:border-border-strong focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60";
const BUTTON_CLASS =
  "rounded-md border border-accent/50 bg-accent/15 px-3 py-2.5 text-sm font-semibold uppercase tracking-widest text-accent transition-[background-color,transform] hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted";
const SECONDARY_CLASS =
  "rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted transition-colors hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-60";
const CHIP_CLASS =
  "rounded border border-border px-2 py-1 text-xs tabular-nums text-muted transition-colors hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

const BUY_PRESETS = ["5", "10", "50"] as const;

const COIN_ERRORS = {
  empty: "Enter an amount.",
  invalid: "Use a plain number such as 10 or 2.5.",
  "too-many-decimals": "At most 6 decimals.",
  "out-of-range": "Amount too large.",
} as const;

const SESSION_LABEL: Record<PlayerSessionView["status"], string> = {
  active: "active",
  expired: "expired",
  "other-device": "on another device",
  "out-of-fees": "out of fee budget",
  none: "none",
};

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `~${hours}h ${minutes}m` : `~${minutes}m`;
}

/** Player account: registration, coins, session key and exit (ADR 0003; spec crash-client-v1 §6). */
export function PlayerPanel() {
  const account = usePlayerAccount();

  return (
    <Panel
      titleId="player-panel-title"
      title="Account"
      icon={<UserRound className="size-3.5" />}
      meta={account.address ? <StatusItem label="wallet" value={shortenAddress(account.address)} /> : undefined}
    >
      <div className="flex flex-col gap-4 p-4">
        {account.wallet !== "connected" && (
          <p className="text-sm text-muted">Connect a devnet wallet to create an account and play.</p>
        )}
        {account.wallet === "connected" && account.status === "loading" && <SkeletonLines />}
        {account.wallet === "connected" && account.status === "error" && (
          <p className="text-sm text-danger">Could not load the account from the RPC. Retrying…</p>
        )}
        {account.wallet === "connected" && account.status === "unregistered" && <RegisterForm />}
        {account.wallet === "connected" && account.status === "registered" && <AccountSummary />}
        <ActionStatus action={account.action} explorerUrl={account.explorerUrl} />
      </div>
    </Panel>
  );
}

function SkeletonLines() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p className="sr-only">Loading account…</p>
      {[70, 45, 85].map((width) => (
        <span key={width} aria-hidden="true" className="h-3 animate-pulse rounded bg-surface-raised" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

function RegisterForm() {
  const account = usePlayerAccount();
  const [username, setUsername] = useState("");
  const [coins, setCoins] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy(account.action);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidUsername(username)) return setError("Username: 3–16 characters of a–z, 0–9 or _.");
    const parsed = parseCoins(coins);
    if (!parsed.ok) return setError(COIN_ERRORS[parsed.error]);
    if (parsed.baseUnits === 0n) return setError("Buy at least some coins to play.");
    const check = await account.checkUsername(username);
    if (check !== "available") return setError(check === "taken" ? "That username is taken." : "Invalid username.");
    setError(null);
    await account.register(username, parsed.baseUnits);
  }

  const parsed = parseCoins(coins);
  const nameOk = isValidUsername(username);
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} noValidate>
      <p className="text-sm text-muted">
        Create your on-chain account. One wallet signature registers the name, buys coins and opens a 24 h betting
        session on this device.
      </p>
      <label className="flex flex-col gap-1.5 text-xs text-muted">
        Username (public, permanent)
        <input
          className={INPUT_CLASS}
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          placeholder="a–z 0–9 _"
          disabled={busy}
        />
      </label>
      <p aria-hidden="true" className={`-mt-2 text-[11px] ${username === "" ? "text-muted/60" : nameOk ? "text-accent" : "text-warn"}`}>
        {username.length}/16 · {nameOk ? "format ok" : "3–16 of a–z, 0–9, _"}
      </p>
      <label className="flex flex-col gap-1.5 text-xs text-muted">
        Coins to buy (1 coin = 0.001 SOL)
        <input
          className={INPUT_CLASS}
          value={coins}
          onChange={(event) => setCoins(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={busy}
        />
      </label>
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted">
        Wallet pays ≈{" "}
        <span className="tabular-nums text-fg">
          {parsed.ok ? formatCoins(parsed.baseUnits + account.registrationOverhead) : "—"}
        </span>{" "}
        coins in SOL: the coins plus {formatCoins(account.registrationOverhead)} for account rent and the session&apos;s
        fee budget. Unused fee budget returns to your wallet when you exit.
      </div>
      {error && (
        <p role="alert" className="animate-shake text-xs text-danger">
          {error}
        </p>
      )}
      <button type="submit" className={BUTTON_CLASS} disabled={busy}>
        Create account
      </button>
    </form>
  );
}

function AccountSummary() {
  const account = usePlayerAccount();
  const [coins, setCoins] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy(account.action);
  const { session } = account;
  const active = session.status === "active";

  async function buy(event: FormEvent) {
    event.preventDefault();
    const parsed = parseCoins(coins);
    if (!parsed.ok) return setError(COIN_ERRORS[parsed.error]);
    if (parsed.baseUnits === 0n) return setError("Enter an amount above zero.");
    setError(null);
    await account.buy(parsed.baseUnits);
  }

  const spentRatio = session.spendCap > 0n ? Number((session.spent * 1000n) / session.spendCap) / 1000 : 0;
  const initial = (account.username ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-lg font-semibold text-accent"
        >
          {initial}
        </span>
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-[11px] uppercase tracking-widest text-muted">user</dt>
          <dd className="truncate">{account.username ?? "(no name)"}</dd>
          <dt className="text-[11px] uppercase tracking-widest text-muted">balance</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {account.balance === null ? "—" : `${formatCoins(account.balance)} coins`}
          </dd>
        </dl>
      </div>

      <section aria-label="Betting session" className="flex flex-col gap-2 rounded-md border border-border bg-surface-raised/40 p-3 text-xs">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <KeyRound aria-hidden="true" className={`size-3.5 ${active ? "text-accent" : "text-warn"}`} />
          <span className="text-muted">session</span>
          <span className={active ? "text-accent" : "text-warn"}>{SESSION_LABEL[session.status]}</span>
          {active && session.expiresInSeconds !== null && (
            <span className="ml-auto inline-flex items-center gap-1 text-muted">
              <Clock aria-hidden="true" className="size-3" />
              expires {formatDuration(session.expiresInSeconds)}
            </span>
          )}
        </p>
        {session.status !== "none" && (
          <>
            <Meter ratio={spentRatio} tone={spentRatio >= 0.9 ? "warn" : "ok"} />
            <p className="flex justify-between text-muted">
              <span>spent / cap</span>
              <span className="tabular-nums text-fg">
                {formatCoins(session.spent)} / {formatCoins(session.spendCap)} coins
              </span>
            </p>
          </>
        )}
        {!active && (
          <button type="button" className={`${BUTTON_CLASS} mt-1`} disabled={busy} onClick={() => void account.renewSession()}>
            Open betting session
          </button>
        )}
      </section>

      <form className="flex flex-col gap-2" onSubmit={(event) => void buy(event)} noValidate>
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs text-muted" htmlFor="buy-coins">
            Coins to buy
          </label>
          <div className="flex gap-1">
            {BUY_PRESETS.map((preset) => (
              <button key={preset} type="button" className={CHIP_CLASS} disabled={busy} onClick={() => setCoins(preset)}>
                {preset}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <input
            id="buy-coins"
            className={INPUT_CLASS}
            value={coins}
            onChange={(event) => setCoins(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            disabled={busy}
          />
          <button type="submit" className={SECONDARY_CLASS} disabled={busy}>
            Buy
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="animate-shake text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {active && (
          <button type="button" className={SECONDARY_CLASS} disabled={busy} onClick={() => void account.revokeSession()}>
            Revoke session
          </button>
        )}
        <button
          type="button"
          className={`${SECONDARY_CLASS} hover:border-danger/50 hover:text-danger`}
          disabled={busy || account.hasActiveBet}
          title={account.hasActiveBet ? "Wait until your bet is settled" : undefined}
          onClick={() => void account.exit()}
        >
          Sell all &amp; exit
        </button>
      </div>
    </div>
  );
}
