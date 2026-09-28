use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Limits {
    pub min_stake: u64,
    pub max_stake: u64,
    pub max_payout: u64,
    pub max_round_exposure: u64,
}

impl Limits {
    pub fn to_rules(self) -> crash_rules::BetLimits {
        crash_rules::BetLimits {
            min_stake: self.min_stake,
            max_stake: self.max_stake,
            max_payout: self.max_payout,
            max_round_exposure: self.max_round_exposure,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Timeouts {
    pub betting_slots: u64,
    pub entropy_timeout_slots: u64,
    pub reveal_grace_slots: u64,
}

#[account]
#[derive(InitSpace)]
pub struct HouseConfig {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub rules_version: u16,
    pub limits: Limits,
    pub max_bets_per_round: u32,
    pub timeouts: Timeouts,
    pub paused: bool,
    pub next_round_id: u64,
    pub current_round: Option<u64>,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Holds the bank and the stakes as lamports; `reserved_exposure` covers every active bet.
#[account]
#[derive(InitSpace)]
pub struct HouseVault {
    pub reserved_exposure: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RoundPhase {
    Betting,
    AwaitingEntropy,
    Running,
    Crashed,
    Settled,
    Voided,
    Forfeited,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub rules_version: u16,
    pub phase: RoundPhase,
    pub commit: [u8; 32],
    pub opened_slot: u64,
    pub betting_end_slot: u64,
    pub entropy_deadline_slot: u64,
    pub start_slot: u64,
    pub reveal_deadline_slot: u64,
    pub vrf_output: [u8; 32],
    pub seed: [u8; 32],
    pub crash_point: u64,
    pub crash_tick: u64,
    pub total_exposure: u64,
    pub bet_count: u32,
    pub settled_count: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum BetStatus {
    Active,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum BetOutcome {
    Pending,
    CashedOut,
    Lost,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub round_id: u64,
    pub player: Pubkey,
    pub stake: u64,
    /// Auto cash-out target in ten-thousandths; 0 means none.
    pub auto_cash_out: u64,
    pub exposure: u64,
    pub cash_out_tick: Option<u64>,
    pub status: BetStatus,
    pub outcome: BetOutcome,
    pub settled_multiplier: u64,
    pub payout: u64,
    pub bump: u8,
}

impl Bet {
    pub fn auto_target(&self) -> Option<u64> {
        (self.auto_cash_out != 0).then_some(self.auto_cash_out)
    }
}
