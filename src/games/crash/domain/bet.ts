import type { Amount, Multiplier } from "./units";

export interface Bet {
  id: string;
  stake: Amount;
  /** Auto cash-out target, centi-precise; `null` when the player cashes out manually only. */
  autoCashOut: Multiplier | null;
}

/** A manual cash-out request with the tick recognized by the settlement authority. */
export interface CashOutRequest {
  betId: string;
  tick: number;
}
