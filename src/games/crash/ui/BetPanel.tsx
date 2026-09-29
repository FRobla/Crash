"use client";

import { useState, type FormEvent } from "react";
import { formatCoins, parseCoins } from "@/platform/player-accounts/coins";
import { Panel } from "@/platform/shell/Panel";
import { ActionStatus } from "@/platform/transactions/ActionStatus";
import { isBusy } from "@/platform/transactions/action-state";
import { useCrashGame } from "./crash-game";
import { formatMultiplier, parseMultiplierText } from "./multiplier-text";
import { betAwaitingSettlement, cashedOutAt, cashOutOffer, checkNewBet, myBetOutcome } from "./round-view";
import { useEstimatedTick } from "./use-estimated-tick";

const INPUT_CLASS =
  "w-full min-w-0 border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg placeholder:text-muted disabled:cursor-not-allowed";
const PRIMARY_CLASS =
  "border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold uppercase tracking-widest text-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted";
const CASH_OUT_CLASS =
  "border border-warn/60 bg-warn/10 px-3 py-3 text-base font-semibold uppercase tracking-widest text-warn disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted";

/** Bet form, live cash-out and the player's bet (spec crash-client-v1 §6). Amounts in coins. */
export function BetPanel() {
  const game = useCrashGame();
  const tick = useEstimatedTick(game);
  const [stakeText, setStakeText] = useState("1");
  const [autoText, setAutoText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const busy = isBusy(game.action);

  const stake = parseCoins(stakeText);
  const auto = autoText.trim() === "" ? null : parseMultiplierText(autoText);
  let check: { ok: boolean; reason?: string } = { ok: false, reason: "Enter a valid stake." };
  if (stake.ok && (auto === null || auto.ok)) {
    check = checkNewBet(game, tick, stake.baseUnits, auto === null ? null : auto.multiplier);
  } else if (auto && !auto.ok) {
    check = { ok: false, reason: "Auto cash-out: a multiplier such as 2 or 1.50." };
  }

  const offer = cashOutOffer(game.round, game.myBet, tick);
  const pendingPrevious = betAwaitingSettlement(game.myBet, game.round);
  const outcome = myBetOutcome(game.round, game.myBet);
  const recordedCashOut = cashedOutAt(game.round, game.myBet);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stake.ok || !check.ok) return setFormError(check.reason ?? "Invalid bet.");
    setFormError(null);
    await game.placeBet(stake.baseUnits, auto && auto.ok ? auto.multiplier : 0n);
  }

  return (
    <Panel titleId="bet-panel-title" title="Bet" className="lg:self-start">
      <div className="flex flex-col gap-4 p-4">
        {game.limits && (
          <p className="text-xs text-muted">
            Stake {formatCoins(game.limits.minStake, 0)}–{formatCoins(game.limits.maxStake, 0)} coins · max payout{" "}
            {formatCoins(game.limits.maxPayout, 0)} · balance{" "}
            {game.balance === null ? "—" : formatCoins(game.balance)}
          </p>
        )}

        {offer && (
          <button type="button" className={CASH_OUT_CLASS} disabled={busy} onClick={() => void game.cashOut()}>
            Cash out ~{formatMultiplier(offer.multiplier)} · {formatCoins(offer.payout)}
          </button>
        )}

        {game.myBet && (
          <section aria-label="Your bet" className="border border-border p-3 text-sm">
            <p className="text-xs uppercase tracking-widest text-muted">Your bet · round #{game.myBet.roundId.toString()}</p>
            <p className="tabular-nums">
              {formatCoins(game.myBet.stake)} coins
              {game.myBet.autoCashOut !== 0n && ` · auto ${formatMultiplier(game.myBet.autoCashOut)}`}
              {recordedCashOut !== null && ` · cash-out recorded at ${formatMultiplier(recordedCashOut)}`}
            </p>
            <p className="text-xs">
              {outcome.kind === "open" && <span className="text-muted">in play</span>}
              {outcome.kind === "cashed-out" && (
                <span className="text-accent">
                  won {formatCoins(outcome.payout)} at {formatMultiplier(outcome.multiplier)}
                </span>
              )}
              {outcome.kind === "lost" && <span className="text-danger">lost</span>}
              {outcome.kind === "refunded" && <span className="text-warn">refunded {formatCoins(outcome.payout)}</span>}
              {outcome.kind !== "open" && <span className="text-muted"> · pending settlement</span>}
            </p>
            {pendingPrevious && (
              <button type="button" className="mt-2 text-xs text-accent underline" disabled={busy} onClick={() => void game.settle()}>
                Settle now
              </button>
            )}
          </section>
        )}

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Stake (coins)
            <input
              name="amount"
              className={INPUT_CLASS}
              value={stakeText}
              onChange={(event) => setStakeText(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Auto cash-out (multiplier)
            <input
              name="autoCashOut"
              className={INPUT_CLASS}
              value={autoText}
              onChange={(event) => setAutoText(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="off"
              disabled={busy}
            />
          </label>
          <button
            type="submit"
            className={PRIMARY_CLASS}
            disabled={busy || !check.ok}
            aria-describedby="bet-blocker"
          >
            {pendingPrevious ? "Settle & place bet" : "Place bet"}
          </button>
          <p id="bet-blocker" className="min-h-4 text-xs text-warn">
            {formError ?? (check.ok ? "" : check.reason)}
          </p>
        </form>
        <ActionStatus
          action={game.action}
          explorerUrl={game.explorerUrl}
        />
      </div>
    </Panel>
  );
}
