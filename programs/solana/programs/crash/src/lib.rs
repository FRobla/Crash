//! Crash settlement authority (docs/specs/crash-program.md). Rules come from the pure
//! `crash-rules` crate so the program and the reference vectors cannot drift apart.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod randomness;
pub mod state;
pub mod vault;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("384CfvvBXN52P4vga71WS7VUT9wv1HtB7YTR3UYLtZK4");

#[program]
pub mod crash {
    use super::*;

    pub fn initialize_house(
        ctx: Context<InitializeHouse>,
        operator: Pubkey,
        limits: Limits,
        timeouts: Timeouts,
        max_bets_per_round: u32,
    ) -> Result<()> {
        house::handle_initialize_house(ctx, operator, limits, timeouts, max_bets_per_round)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        operator: Pubkey,
        limits: Limits,
        timeouts: Timeouts,
        max_bets_per_round: u32,
        paused: bool,
    ) -> Result<()> {
        house::handle_update_config(ctx, operator, limits, timeouts, max_bets_per_round, paused)
    }

    pub fn deposit_bank(ctx: Context<DepositBank>, amount: u64) -> Result<()> {
        house::handle_deposit_bank(ctx, amount)
    }

    pub fn withdraw_bank(ctx: Context<WithdrawBank>, amount: u64) -> Result<()> {
        house::handle_withdraw_bank(ctx, amount)
    }

    pub fn open_round(ctx: Context<OpenRound>, commit: [u8; 32]) -> Result<()> {
        round::handle_open_round(ctx, commit)
    }

    pub fn place_bet(
        ctx: Context<PlaceBet>,
        round_id: u64,
        stake: u64,
        auto_cash_out: u64,
    ) -> Result<()> {
        bet::handle_place_bet(ctx, round_id, stake, auto_cash_out)
    }

    pub fn close_betting(ctx: Context<CloseBetting>) -> Result<()> {
        round::handle_close_betting(ctx)
    }

    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        round::handle_start_round(ctx)
    }

    pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
        bet::handle_cash_out(ctx)
    }

    pub fn reveal(ctx: Context<Reveal>, seed: [u8; 32]) -> Result<()> {
        round::handle_reveal(ctx, seed)
    }

    pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
        bet::handle_settle_bet(ctx)
    }

    pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
        round::handle_void_round(ctx)
    }

    pub fn forfeit_round(ctx: Context<ForfeitRound>) -> Result<()> {
        round::handle_forfeit_round(ctx)
    }

    pub fn close_bet(ctx: Context<CloseBet>) -> Result<()> {
        bet::handle_close_bet(ctx)
    }
}
