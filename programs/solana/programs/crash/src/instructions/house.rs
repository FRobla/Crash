use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::*,
    error::CrashError,
    events::{BankDeposited, BankWithdrawn},
    program::Crash,
    state::{HouseConfig, HouseVault, Limits, Timeouts},
    vault::free_lamports,
};

fn validate_config(
    operator: &Pubkey,
    limits: &Limits,
    timeouts: &Timeouts,
    max_bets_per_round: u32,
) -> Result<()> {
    let valid = *operator != Pubkey::default()
        && limits.to_rules().is_valid()
        && limits.max_payout > 0
        && limits.max_round_exposure > 0
        && timeouts.betting_slots > 0
        && timeouts.entropy_timeout_slots > 0
        && timeouts.reveal_grace_slots > 0
        && max_bets_per_round > 0;
    require!(valid, CrashError::InvalidConfig);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeHouse<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + HouseConfig::INIT_SPACE, seeds = [HOUSE_SEED], bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(init, payer = admin, space = 8 + HouseVault::INIT_SPACE, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, HouseVault>,
    /// Only the program's upgrade authority may initialize, so nobody can front-run the admin role.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ CrashError::InvalidConfig)]
    pub program: Program<'info, Crash>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CrashError::InvalidConfig)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_house(
    ctx: Context<InitializeHouse>,
    operator: Pubkey,
    limits: Limits,
    timeouts: Timeouts,
    max_bets_per_round: u32,
) -> Result<()> {
    validate_config(&operator, &limits, &timeouts, max_bets_per_round)?;
    ctx.accounts.config.set_inner(HouseConfig {
        admin: ctx.accounts.admin.key(),
        operator,
        rules_version: RULES_VERSION,
        limits,
        max_bets_per_round,
        timeouts,
        paused: false,
        next_round_id: 0,
        current_round: None,
        bump: ctx.bumps.config,
        vault_bump: ctx.bumps.vault,
    });
    ctx.accounts.vault.set_inner(HouseVault {
        reserved_exposure: 0,
        bump: ctx.bumps.vault,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, HouseConfig>,
}

/// Changes apply to future bets only; accepted bets keep their reserved exposure.
pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    operator: Pubkey,
    limits: Limits,
    timeouts: Timeouts,
    max_bets_per_round: u32,
    paused: bool,
) -> Result<()> {
    validate_config(&operator, &limits, &timeouts, max_bets_per_round)?;
    let config = &mut ctx.accounts.config;
    config.operator = operator;
    config.limits = limits;
    config.timeouts = timeouts;
    config.max_bets_per_round = max_bets_per_round;
    config.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct DepositBank<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, HouseVault>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_bank(ctx: Context<DepositBank>, amount: u64) -> Result<()> {
    require!(amount > 0, CrashError::ZeroAmount);
    let accounts = system_program::Transfer {
        from: ctx.accounts.admin.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
    };
    system_program::transfer(CpiContext::new(system_program::ID, accounts), amount)?;
    emit!(BankDeposited { amount });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawBank<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, HouseVault>,
}

pub fn handle_withdraw_bank(ctx: Context<WithdrawBank>, amount: u64) -> Result<()> {
    require!(amount > 0, CrashError::ZeroAmount);
    let free = free_lamports(&ctx.accounts.vault.to_account_info())?;
    let available = free.saturating_sub(ctx.accounts.vault.reserved_exposure);
    require!(amount <= available, CrashError::WithdrawalExceedsAvailable);
    ctx.accounts.vault.sub_lamports(amount)?;
    ctx.accounts.admin.add_lamports(amount)?;
    emit!(BankWithdrawn { amount });
    Ok(())
}
