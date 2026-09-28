import { Panel } from "@/platform/shell/Panel";

interface BetPanelProps {
  assets: readonly string[];
  /** Why betting is disabled. Limits, precision and rounding come from the Crash betting spec. */
  unavailableReason: string;
}

const INPUT_CLASS =
  "w-full min-w-0 border border-border bg-bg px-3 py-2 text-sm tabular-nums text-fg placeholder:text-muted disabled:cursor-not-allowed";

/** Bet form layout. Always disabled for now: there is no round engine to accept bets. */
export function BetPanel({ assets, unavailableReason }: BetPanelProps) {
  return (
    <Panel titleId="bet-panel-title" title="Bet" className="lg:self-start">
      <form className="flex flex-col gap-4 p-4" aria-describedby="bet-unavailable-reason">
        <fieldset disabled className="flex min-w-0 flex-col gap-4">
          <legend className="sr-only">Bet parameters</legend>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs text-muted">Asset</legend>
            <div className="flex">
              {assets.map((asset, index) => (
                <label
                  key={asset}
                  className="flex-1 cursor-not-allowed border border-border px-3 py-2 text-center text-sm text-muted has-checked:border-accent/60 has-checked:text-fg [&:not(:first-child)]:-ml-px"
                >
                  <input
                    type="radio"
                    name="asset"
                    value={asset}
                    defaultChecked={index === 0}
                    className="sr-only"
                  />
                  {asset}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Amount
            <input
              name="amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="amount"
              className={INPUT_CLASS}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Auto cash-out (multiplier)
            <input
              name="autoCashOut"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="off"
              className={INPUT_CLASS}
            />
          </label>

          <button
            type="submit"
            disabled
            aria-describedby="bet-unavailable-reason"
            className="border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold uppercase tracking-widest text-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted"
          >
            Place bet
          </button>
        </fieldset>

        <p id="bet-unavailable-reason" className="text-xs text-warn">
          {unavailableReason}
        </p>
      </form>
    </Panel>
  );
}
