//! Crash settlement authority (docs/specs/crash-program-v2.md). Rules come from the pure
//! `crash-rules` crate so the program and the reference vectors cannot drift apart.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod randomness;
pub mod state;
pub mod switchboard;
pub mod vault;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DNmfJzhj6Uaa1Zbd2HhUT9mES27jhzXkMThDm3ikRarM");

#[program]
pub mod crash {
    use super::*;

    pub fn initialize_house(
        ctx: Context<InitializeHouse>,
        operator: Pubkey,
        limits: Limits,
        timeouts: Timeouts,
        max_bets_per_round: u32,
        player_policy: PlayerPolicy,
    ) -> Result<()> {
        house::handle_initialize_house(
            ctx,
            operator,
            limits,
            timeouts,
            max_bets_per_round,
            player_policy,
        )
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        operator: Pubkey,
        limits: Limits,
        timeouts: Timeouts,
        max_bets_per_round: u32,
        paused: bool,
        player_policy: PlayerPolicy,
    ) -> Result<()> {
        house::handle_update_config(
            ctx,
            operator,
            limits,
            timeouts,
            max_bets_per_round,
            paused,
            player_policy,
        )
    }

    pub fn deposit_bank(ctx: Context<DepositBank>, amount: u64) -> Result<()> {
        house::handle_deposit_bank(ctx, amount)
    }

    pub fn withdraw_bank(ctx: Context<WithdrawBank>, amount: u64) -> Result<()> {
        house::handle_withdraw_bank(ctx, amount)
    }

    pub fn create_randomness_account(
        ctx: Context<CreateRandomnessAccount>,
        recent_slot: u64,
    ) -> Result<()> {
        house::handle_create_randomness_account(ctx, recent_slot)
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

    pub fn start_round(
        ctx: Context<StartRound>,
        signature: [u8; 64],
        recovery_id: u8,
        value: [u8; 32],
    ) -> Result<()> {
        round::handle_start_round(ctx, signature, recovery_id, value)
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

    pub fn register_player(ctx: Context<RegisterPlayer>, username: String) -> Result<()> {
        player::handle_register_player(ctx, username)
    }

    pub fn buy_coins(ctx: Context<BuyCoins>, amount: u64) -> Result<()> {
        player::handle_buy_coins(ctx, amount)
    }

    pub fn sell_coins(ctx: Context<SellCoins>, amount: u64) -> Result<()> {
        player::handle_sell_coins(ctx, amount)
    }

    pub fn create_session(
        ctx: Context<CreateSession>,
        expires_slot: u64,
        spend_cap: u64,
        fee_budget: u64,
    ) -> Result<()> {
        player::handle_create_session(ctx, expires_slot, spend_cap, fee_budget)
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        player::handle_revoke_session(ctx)
    }

    pub fn change_username(ctx: Context<ChangeUsername>, username: String) -> Result<()> {
        player::handle_change_username(ctx, username)
    }

    pub fn reset_username(ctx: Context<ResetUsername>) -> Result<()> {
        player::handle_reset_username(ctx)
    }

    pub fn close_player(ctx: Context<ClosePlayer>) -> Result<()> {
        player::handle_close_player(ctx)
    }
}
