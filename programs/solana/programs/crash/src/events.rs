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
    pub player: Pubkey,
    pub stake: u64,
    pub auto_cash_out: u64,
    pub exposure: u64,
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

#[event]
pub struct BetSettled {
    pub round_id: u64,
    pub player: Pubkey,
    pub outcome: BetOutcome,
    pub multiplier: u64,
    pub payout: u64,
}

#[event]
pub struct RoundVoided {
    pub round_id: u64,
}

#[event]
pub struct RoundForfeited {
    pub round_id: u64,
}
