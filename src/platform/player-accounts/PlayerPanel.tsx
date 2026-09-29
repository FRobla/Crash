"use client";

import { useState, type FormEvent } from "react";
import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";
import { ActionStatus } from "@/platform/transactions/ActionStatus";
import { isBusy } from "@/platform/transactions/action-state";
import { shortenAddress } from "@/platform/wallets/wallet-session";
import { formatCoins, parseCoins } from "./coins";
import { isValidUsername, usePlayerAccount, type PlayerSessionView } from "./player-account";

const INPUT_CLASS =
  "w-full min-w-0 border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg placeholder:text-muted disabled:cursor-not-allowed";
const BUTTON_CLASS =
  "border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold uppercase tracking-widest text-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted";
const SECONDARY_CLASS =
  "border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-60";

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
      meta={account.address ? <StatusItem label="wallet" value={shortenAddress(account.address)} /> : undefined}
    >
      <div className="flex flex-col gap-4 p-4">
        {account.wallet !== "connected" && (
          <p className="text-sm text-muted">Connect a devnet wallet to create an account and play.</p>
        )}
        {account.wallet === "connected" && account.status === "loading" && (
          <p className="text-sm text-muted">Loading account…</p>
        )}
        {account.wallet === "connected" && account.status === "error" && (
          <p className="text-sm text-danger">Could not load the account from the RPC. Retrying…</p>
        )}
        {account.wallet === "connected" && account.status === "unregistered" && <RegisterForm />}
        {account.wallet === "connected" && account.status === "registered" && <AccountSummary />}
        <ActionStatus
          action={account.action}
          explorerUrl={account.explorerUrl}
        />
      </div>
    </Panel>
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
      <p className="text-xs text-muted">
        Wallet pays ≈ {parsed.ok ? formatCoins(parsed.baseUnits + account.registrationOverhead) : "—"} coins in SOL:
        the coins plus {formatCoins(account.registrationOverhead)} for account rent and the session&apos;s fee budget.
        Unused fee budget returns to your wallet when you exit.
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
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

  async function buy(event: FormEvent) {
    event.preventDefault();
    const parsed = parseCoins(coins);
    if (!parsed.ok) return setError(COIN_ERRORS[parsed.error]);
    if (parsed.baseUnits === 0n) return setError("Enter an amount above zero.");
    setError(null);
    await account.buy(parsed.baseUnits);
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">user</dt>
        <dd>{account.username ?? "(no name)"}</dd>
        <dt className="text-muted">balance</dt>
        <dd className="tabular-nums">{account.balance === null ? "—" : `${formatCoins(account.balance)} coins`}</dd>
        <dt className="text-muted">session</dt>
        <dd className={session.status === "active" ? "text-accent" : "text-warn"}>
          {SESSION_LABEL[session.status]}
          {session.status === "active" && session.expiresInSeconds !== null && (
            <span className="text-muted"> · expires {formatDuration(session.expiresInSeconds)}</span>
          )}
        </dd>
        {session.status !== "none" && (
          <>
            <dt className="text-muted">spent</dt>
            <dd className="tabular-nums">
              {formatCoins(session.spent)} / {formatCoins(session.spendCap)} coins
            </dd>
          </>
        )}
      </dl>

      {session.status !== "active" && (
        <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void account.renewSession()}>
          Open betting session
        </button>
      )}

      <form className="flex gap-2" onSubmit={(event) => void buy(event)} noValidate>
        <label className="sr-only" htmlFor="buy-coins">
          Coins to buy
        </label>
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
      </form>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {session.status === "active" && (
          <button type="button" className={SECONDARY_CLASS} disabled={busy} onClick={() => void account.revokeSession()}>
            Revoke session
          </button>
        )}
        <button
          type="button"
          className={SECONDARY_CLASS}
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
