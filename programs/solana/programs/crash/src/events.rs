use anchor_lang::prelude::*;

use crate::state::BetOutcome;

/// Authoritative events: off-chain projections must be rebuildable from these and the `Round` accounts.

#[event]
pub struct BankDeposited {
    pub amount: u64,
}

#[event]
pub struct BankWithdrawn {
    pub amount: u64,
}

#[event]
pub struct RandomnessAccountSet {
    pub randomness_account: Pubkey,
}

#[event]
pub struct RoundOpened {
    pub round_id: u64,
    pub commit: [u8; 32],
    pub betting_end_slot: u64,
}

#[event]
pub struct BetPlaced {
    pub round_id: u64,
    /// Wallet that owns the `Player` account.
    pub player: Pubkey,
    pub stake: u64,
    pub auto_cash_out: u64,
    pub exposure: u64,
    pub by_session: bool,
    pub balance: u64,
}

#[event]
pub struct BettingClosed {
    pub round_id: u64,
    pub randomness_account: Pubkey,
    pub randomness_seed_slot: u64,
    pub entropy_deadline_slot: u64,
}

#[event]
pub struct RoundStarted {
    pub round_id: u64,
    pub vrf_output: [u8; 32],
    pub start_slot: u64,
    pub reveal_deadline_slot: u64,
}

#[event]
pub struct CashOutRecorded {
    pub round_id: u64,
    pub player: Pubkey,
    pub tick: u64,
    pub multiplier: u64,
}

#[event]
pub struct RoundRevealed {
    pub round_id: u64,
    pub seed: [u8; 32],
    pub vrf_output: [u8; 32],
    pub crash_point: u64,
    pub crash_tick: u64,
}

/// Self-contained record of a bet, so it stays auditable without per-bet accounts (spec v2 §10).
#[event]
pub struct BetSettled {
    pub round_id: u64,
    pub player: Pubkey,
    pub stake: u64,
    pub auto_cash_out: u64,
    pub cash_out_tick: Option<u64>,
    pub outcome: BetOutcome,
    pub multiplier: u64,
    pub payout: u64,
    pub balance: u64,
    pub total_wagered: u64,
}

#[event]
pub struct RoundVoided {
    pub round_id: u64,
}

#[event]
pub struct RoundForfeited {
    pub round_id: u64,
}

#[event]
pub struct PlayerRegistered {
    pub owner: Pubkey,
    pub username: String,
}

#[event]
pub struct CoinsBought {
    pub owner: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[event]
pub struct CoinsSold {
    pub owner: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[event]
pub struct SessionCreated {
    pub owner: Pubkey,
    pub key: Pubkey,
    pub expires_slot: u64,
    pub spend_cap: u64,
}

#[event]
pub struct SessionRevoked {
    pub owner: Pubkey,
    pub key: Pubkey,
}

#[event]
pub struct UsernameChanged {
    pub owner: Pubkey,
    pub old: String,
    pub new: String,
}

#[event]
pub struct UsernameReset {
    pub owner: Pubkey,
    pub old: String,
}

#[event]
pub struct PlayerClosed {
    pub owner: Pubkey,
}
