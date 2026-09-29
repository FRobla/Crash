"use client";

import { Clock, Coins, PartyPopper, Target, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatCoins, parseCoins } from "@/platform/player-accounts/coins";
import { Panel } from "@/platform/shell/Panel";
import { ActionStatus } from "@/platform/transactions/ActionStatus";
import { isBusy } from "@/platform/transactions/action-state";
import { validateBet, type BetLimits } from "../domain/limits";
import { rulesForVersion } from "../domain/rules";
import { payoutFor, type Amount, type Multiplier } from "../domain/units";
import { useCrashGame, type CrashGamePort, type LiveRound } from "./crash-game";
import { formatMultiplier, parseMultiplierText } from "./multiplier-text";
import {
  applyEarlyCrash,
  autoTargetReached,
  betAwaitingSettlement,
  cashedOutAt,
  cashOutOffer,
  checkNewBet,
  myBetOutcome,
  projectedMultiplier,
  type MyBetOutcome,
} from "./round-view";
import { playSound } from "./sound";
import { useEarlyCrash } from "./use-early-crash";
import { useEstimatedTick } from "./use-estimated-tick";
import { useShownMultiplier } from "./use-shown-multiplier";

/** A bet waiting for the next round (spec crash-client-v1 §6.2): one, in memory, cancelable. */
interface QueuedBet {
  stake: Amount;
  autoCashOut: Multiplier | null;
  /** Placed in the first betting round after this one. */
  afterRoundId: bigint;
  /** What it was validated against; any change clears it. */
  limitsKey: string;
  balance: Amount | null;
}

function limitsKey(limits: BetLimits | null): string {
  return limits ? [limits.minStake, limits.maxStake, limits.maxPayout, limits.maxRoundExposure].join(":") : "";
}

/** Why a bet cannot be queued now, or null. The program still checks everything when it is sent. */
function queueBlocker(game: CrashGamePort, stake: Amount, autoCashOut: Multiplier | null): string | null {
  if (game.playerBlocker) return game.playerBlocker;
  if (game.paused) return "The house is paused.";
  const rules = game.round ? rulesForVersion(game.round.rulesVersion) : null;
  if (!game.limits || !rules) return "House limits not loaded.";
  if (game.balance !== null && stake > game.balance) return "Not enough coins.";
  const result = validateBet({ stake, autoCashOut }, game.limits, rules.maxMultiplier);
  return result.ok ? null : "Check the stake and auto cash-out.";
}

/**
 * Remembers a win the rules granted until its settlement lands, then reports it once, when the
 * confirmed balance reflects it. Never celebrates a projection.
 */
function useConfirmedWin(game: CrashGamePort, outcome: MyBetOutcome): { roundId: bigint; payout: Amount } | null {
  const [pending, setPending] = useState<{ roundId: bigint; payout: Amount; balance: Amount | null } | null>(null);
  const [won, setWon] = useState<{ roundId: bigint; payout: Amount } | null>(null);
  const betRound = game.myBet?.roundId ?? null;
  if (outcome.kind === "cashed-out" && betRound !== null && pending?.roundId !== betRound) {
    setPending({ roundId: betRound, payout: outcome.payout, balance: game.balance });
  }
  if (pending && betRound !== pending.roundId) {
    // The bet left the account: settled. Celebrate only if the balance actually grew.
    if (game.balance !== null && pending.balance !== null && game.balance > pending.balance) {
      setWon({ roundId: pending.roundId, payout: pending.payout });
    }
    setPending(null);
  }
  useEffect(() => {
    if (!won) return;
    playSound("settled");
    const id = setTimeout(() => setWon(null), 2_600);
    return () => clearTimeout(id);
  }, [won]);
  return won;
}

const INPUT_CLASS =
  "w-full min-w-0 rounded-md border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg transition-colors placeholder:text-muted hover:border-border-strong focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY_CLASS =
  "rounded-md border border-accent/50 bg-accent/15 px-3 py-3 text-sm font-semibold uppercase tracking-widest text-accent transition-[background-color,transform] hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted disabled:active:scale-100";
const CASH_OUT_CLASS =
  "flex animate-glow flex-col items-center gap-0.5 rounded-md border border-warn/70 bg-warn/15 px-3 py-4 font-semibold text-warn transition-[background-color,transform] hover:bg-warn/25 active:scale-[0.98] disabled:animate-none disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted";
const CHIP_CLASS =
  "rounded border border-border px-2 py-1 text-xs tabular-nums text-muted transition-colors hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-accent/60 aria-pressed:bg-accent/10 aria-pressed:text-accent";

const AUTO_PRESETS = ["1.5", "2", "3", "10"] as const;

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

  // A crash verified from the live feed ends the round for the offer and the outcome (§5.2).
  const early = useEarlyCrash(game);
  const round = applyEarlyCrash(game.round, early);
  const offer = cashOutOffer(round, game.myBet, tick);
  const pendingPrevious = betAwaitingSettlement(game.myBet, round);
  const outcome = myBetOutcome(round, game.myBet);
  const recordedCashOut = cashedOutAt(round, game.myBet);
  const bettingOpen = round?.phase === "betting";
  const projected = projectedMultiplier(round, tick);
  const autoReached =
    game.myBet !== null &&
    game.myBet.roundId === round?.roundId &&
    game.myBet.cashOutTick === null &&
    projected !== null &&
    autoTargetReached(game.myBet, projected);
  const win = useConfirmedWin(game, outcome);

  // ---- Bet next round (queue) ----
  const [queued, setQueued] = useState<QueuedBet | null>(null);
  const stakeValue = stake.ok ? stake.baseUnits : null;
  const autoValue = auto === null ? null : auto.ok ? auto.multiplier : undefined;
  const queueReason = stakeValue === null || autoValue === undefined ? "Enter a valid bet." : queueBlocker(game, stakeValue, autoValue);
  const canQueue = !bettingOpen && round !== null && queued === null && !game.paused;
  // Adjusting state during render: a queued bet is dropped as soon as what it was checked
  // against changes (wallet or session, house limits, a lower balance).
  if (
    queued &&
    (game.playerBlocker !== null ||
      limitsKey(game.limits) !== queued.limitsKey ||
      (queued.balance !== null && game.balance !== null && game.balance < queued.balance))
  ) {
    setQueued(null);
    setFormError("Queued bet cancelled: your account or the house limits changed.");
  }
  const placing = useRef(false);
  useEffect(() => {
    if (!queued || !game.round || game.round.phase !== "betting" || game.round.roundId <= queued.afterRoundId) return;
    if (busy || placing.current) return;
    // Revalidate against the round that is now open, then send it once.
    const recheck = checkNewBet(game, game.estimatedTick(), queued.stake, queued.autoCashOut);
    placing.current = true;
    const bet = queued;
    void Promise.resolve().then(async () => {
      setQueued(null);
      if (!recheck.ok) setFormError(`Queued bet not placed: ${recheck.reason}`);
      else await game.placeBet(bet.stake, bet.autoCashOut ?? 0n);
      placing.current = false;
    });
  }, [busy, game, queued]);

  /** Outside a betting window with a round on screen, the form queues for the next round. */
  const queueMode = !bettingOpen && round !== null && round.phase !== "betting" && !game.paused;
  const queueReasonShown = queued ? "A bet is already queued for the next round." : queueReason;

  function queueBet() {
    if (!canQueue || round === null || stakeValue === null || autoValue === undefined || queueReason) {
      return setFormError(queueReason ?? "Cannot queue a bet now.");
    }
    setFormError(null);
    setQueued({
      stake: stakeValue,
      autoCashOut: autoValue,
      afterRoundId: round.roundId,
      limitsKey: limitsKey(game.limits),
      balance: game.balance,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (queueMode) return queueBet();
    if (!stake.ok || !check.ok) return setFormError(check.reason ?? "Invalid bet.");
    setFormError(null);
    await game.placeBet(stake.baseUnits, auto && auto.ok ? auto.multiplier : 0n);
  }

  const shortOfCoins =
    game.playerBlocker === null && game.balance !== null && (game.balance === 0n || (stake.ok && stake.baseUnits > game.balance));

  function setStake(value: Amount) {
    setFormError(null);
    setStakeText(formatCoins(value > 0n ? value : 0n, 0));
  }

  const maxStake = game.limits
    ? game.balance !== null && game.balance < game.limits.maxStake
      ? game.balance
      : game.limits.maxStake
    : null;

  return (
    <Panel titleId="bet-panel-title" title="Bet" icon={<Target className="size-3.5" />} tone={offer ? "warn" : "neutral"} className="lg:self-start">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted">Balance</p>
            <p className="flex items-center gap-1.5 text-2xl font-semibold">
              <Coins aria-hidden="true" className="size-5 text-warn" />
              {game.balance === null ? "—" : formatCoins(game.balance)}
              <span className="text-xs font-normal text-muted">coins</span>
            </p>
          </div>
          {game.limits && (
            <dl className="grid grid-cols-[auto_auto] gap-x-2 text-right text-[11px] tabular-nums">
              <dt className="text-muted">stake</dt>
              <dd>
                {formatCoins(game.limits.minStake, 0)}–{formatCoins(game.limits.maxStake, 0)}
              </dd>
              <dt className="text-muted">max payout</dt>
              <dd>{formatCoins(game.limits.maxPayout, 0)}</dd>
            </dl>
          )}
        </div>

        {offer && round && game.myBet && <CashOutButton game={game} round={round} stake={game.myBet.stake} busy={busy} />}

        {win && (
          <p
            key={`win-${win.roundId}`}
            role="status"
            className="flex items-center justify-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-3 py-2 text-lg font-semibold text-accent motion-safe:animate-celebrate"
          >
            <PartyPopper aria-hidden="true" className="size-5" />
            +{formatCoins(win.payout)} coins
            <span className="sr-only"> won in round #{win.roundId.toString()}, settled</span>
          </p>
        )}

        {queued && (
          <section aria-label="Queued bet" className="flex items-center gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-sm">
            <Clock aria-hidden="true" className="size-4 shrink-0 text-info" />
            <p className="min-w-0 flex-1">
              <span className="text-[11px] uppercase tracking-widest text-muted">Next round · </span>
              <span className="tabular-nums">
                {formatCoins(queued.stake)} coins
                {queued.autoCashOut !== null && ` · auto ${formatMultiplier(queued.autoCashOut)}`}
              </span>
              <span className="block text-xs text-muted">Placed with your session when betting opens, after a fresh check.</span>
            </p>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:border-border-strong hover:text-fg"
              onClick={() => setQueued(null)}
            >
              <X aria-hidden="true" className="size-3" />
              Cancel
            </button>
          </section>
        )}

        {game.myBet && (
          <section
            key={`${game.myBet.roundId}-${outcome.kind}`}
            aria-label="Your bet"
            className={`animate-rise-in rounded-md border p-3 text-sm ${OUTCOME_CARD[outcome.kind]}`}
          >
            <p className="text-[11px] uppercase tracking-widest text-muted">Your bet · round #{game.myBet.roundId.toString()}</p>
            <p className="mt-1 tabular-nums">
              {formatCoins(game.myBet.stake)} coins
              {game.myBet.autoCashOut !== 0n && ` · auto ${formatMultiplier(game.myBet.autoCashOut)}`}
              {recordedCashOut !== null && ` · cash-out recorded at ${formatMultiplier(recordedCashOut)}`}
            </p>
            <p className="mt-1 text-xs">
              <OutcomeText outcome={outcome} />
              {outcome.kind !== "open" && <span className="text-muted"> · pending settlement</span>}
            </p>
            {autoReached && outcome.kind === "open" && game.myBet.autoCashOut !== 0n && (
              <p className="mt-1 text-xs text-accent">
                Auto {formatMultiplier(game.myBet.autoCashOut)} reached (estimated): it pays if the revealed crash point
                is at least {formatMultiplier(game.myBet.autoCashOut)}.
              </p>
            )}
            {pendingPrevious && (
              <button type="button" className="mt-2 text-xs text-accent underline hover:no-underline" disabled={busy} onClick={() => void game.settle()}>
                Settle now
              </button>
            )}
          </section>
        )}

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            label={
              <label htmlFor="bet-stake" className="text-xs text-muted">
                Stake (coins)
              </label>
            }
            chips={
              <>
                <Chip disabled={busy || !stake.ok} onClick={() => stake.ok && setStake(stake.baseUnits / 2n)} label="Half the stake">
                  ½
                </Chip>
                <Chip disabled={busy || !stake.ok} onClick={() => stake.ok && setStake(stake.baseUnits * 2n)} label="Double the stake">
                  2×
                </Chip>
                <Chip disabled={busy || !game.limits} onClick={() => game.limits && setStake(game.limits.minStake)} label="Minimum stake">
                  min
                </Chip>
                <Chip disabled={busy || maxStake === null} onClick={() => maxStake !== null && setStake(maxStake)} label="Maximum stake">
                  max
                </Chip>
              </>
            }
          >
            <input
              id="bet-stake"
              name="amount"
              className={INPUT_CLASS}
              value={stakeText}
              onChange={(event) => setStakeText(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          <Field
            label={
              <label htmlFor="bet-auto" className="text-xs text-muted">
                Auto cash-out (multiplier)
              </label>
            }
            chips={
              <>
                <Chip pressed={autoText.trim() === ""} disabled={busy} onClick={() => setAutoText("")} label="Auto cash-out off">
                  off
                </Chip>
                {AUTO_PRESETS.map((preset) => (
                  <Chip key={preset} pressed={autoText.trim() === preset} disabled={busy} onClick={() => setAutoText(preset)} label={`Auto cash-out at ${preset}x`}>
                    {preset}x
                  </Chip>
                ))}
              </>
            }
          >
            <input
              id="bet-auto"
              name="autoCashOut"
              className={INPUT_CLASS}
              value={autoText}
              onChange={(event) => setAutoText(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="off"
              disabled={busy}
            />
          </Field>

          <BetPreview stake={stake.ok ? stake.baseUnits : null} auto={auto && auto.ok ? auto.multiplier : null} />

          {queueMode ? (
            <button
              type="submit"
              className={`${PRIMARY_CLASS} border-info/50 bg-info/10 text-info hover:bg-info/20`}
              disabled={busy || queueReasonShown !== null}
              aria-describedby="bet-blocker"
            >
              Bet next round
            </button>
          ) : (
            <button
              type="submit"
              className={`${PRIMARY_CLASS} ${bettingOpen && check.ok && !busy ? "shadow-[0_0_24px_-6px] shadow-accent/50" : ""}`}
              disabled={busy || !check.ok}
              aria-describedby="bet-blocker"
            >
              {pendingPrevious ? "Settle & place bet" : "Place bet"}
            </button>
          )}
          <p id="bet-blocker" className="-mt-2 min-h-4 text-xs text-warn">
            {formError ?? (queueMode ? (queueReasonShown ?? "") : check.ok ? "" : check.reason)}
          </p>
          {shortOfCoins && (
            <a href="#buy-coins" className="-mt-2 text-xs text-accent underline hover:no-underline">
              Buy coins in the account panel
            </a>
          )}
        </form>
        <ActionStatus action={game.action} explorerUrl={game.explorerUrl} />
      </div>
    </Panel>
  );
}

/**
 * Manual cash-out. Whether it is offered is decided on whole ticks (`cashOutOffer`); what it shows
 * is the headline's own continuous multiplier, so both read the same (spec crash-client-v1 §5.2).
 * The amount actually paid is set by the slot where the cash-out lands.
 */
function CashOutButton({ game, round, stake, busy }: { game: CrashGamePort; round: LiveRound; stake: Amount; busy: boolean }) {
  const shown = useShownMultiplier(round, game, true);
  return (
    <button type="button" className={CASH_OUT_CLASS} disabled={busy} onClick={() => void game.cashOut()}>
      <span className="text-lg uppercase tracking-widest tabular-nums">Cash out ~{formatMultiplier(shown)}</span>
      <span className="sr-only"> · </span>
      <span className="text-sm font-normal tabular-nums text-fg">~{formatCoins(payoutFor(stake, shown))} coins</span>
    </button>
  );
}

const OUTCOME_CARD: Record<MyBetOutcome["kind"], string> = {
  open: "border-border bg-surface-raised/50",
  "cashed-out": "animate-win-flash border-accent/50 bg-accent/10",
  lost: "border-danger/40 bg-danger/5",
  refunded: "border-warn/40 bg-warn/5",
};

function OutcomeText({ outcome }: { outcome: MyBetOutcome }) {
  switch (outcome.kind) {
    case "open":
      return <span className="text-muted">in play</span>;
    case "cashed-out":
      return (
        <span className="font-semibold text-accent">
          won {formatCoins(outcome.payout)} at {formatMultiplier(outcome.multiplier)}
        </span>
      );
    case "lost":
      return <span className="text-danger">lost</span>;
    case "refunded":
      return <span className="text-warn">refunded {formatCoins(outcome.payout)}</span>;
  }
}

/** What the bet would pay if the auto cash-out triggers; computed with the domain's payout rule. */
function BetPreview({ stake, auto }: { stake: Amount | null; auto: Multiplier | null }) {
  if (stake === null || stake === 0n) return null;
  if (auto === null) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted">
        Manual cash-out: you choose when to cash out while the round runs.
      </p>
    );
  }
  const payout = payoutFor(stake, auto);
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted">
      At {formatMultiplier(auto)} pays <span className="tabular-nums text-fg">{formatCoins(payout)}</span> coins (
      <span className="tabular-nums text-accent">+{formatCoins(payout - stake)}</span>)
    </p>
  );
}

function Field({ label, chips, children }: { label: ReactNode; chips: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {label}
        <div className="flex flex-wrap gap-1">{chips}</div>
      </div>
      {children}
    </div>
  );
}

function Chip({
  children,
  label,
  onClick,
  disabled,
  pressed,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button type="button" className={CHIP_CLASS} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
