use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::*,
    error::CrashError,
    events::{BankDeposited, BankWithdrawn, RandomnessAccountSet},
    program::Crash,
    state::{HouseConfig, HouseVault, Limits, Timeouts},
    switchboard,
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
        randomness_account: Pubkey::default(),
        bump: ctx.bumps.config,
        vault_bump: ctx.bumps.vault,
        randomness_authority_bump: 0,
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

/// Switchboard accounts are validated by Switchboard itself; the program only pins the fixed
/// addresses, signs as the authority PDA and checks the created account afterwards (spec §6.1).
#[derive(Accounts)]
pub struct CreateRandomnessAccount<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, HouseConfig>,
    /// Fresh keypair; Switchboard creates the account at this address.
    #[account(mut)]
    pub randomness: Signer<'info>,
    /// CHECK: signer-only PDA, never read.
    #[account(seeds = [RANDOMNESS_AUTHORITY_SEED], bump)]
    pub randomness_authority: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (wSOL associated token account of `randomness`).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (queue the account is bound to).
    #[account(mut)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (its global state PDA).
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (lookup-table signer PDA of `randomness`).
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (lookup table derived from `lut_signer` and `recent_slot`).
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: fixed address.
    #[account(address = switchboard::TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::WRAPPED_SOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::ADDRESS_LOOKUP_TABLE_PROGRAM)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    /// CHECK: pinned Switchboard program id.
    #[account(address = switchboard::PROGRAM_ID @ CrashError::InvalidRandomnessAccount)]
    pub switchboard_program: UncheckedAccount<'info>,
}

/// Creates (or rotates) the house randomness account with the program PDA as its authority.
pub fn handle_create_randomness_account(
    ctx: Context<CreateRandomnessAccount>,
    recent_slot: u64,
) -> Result<()> {
    require!(
        ctx.accounts.config.current_round.is_none(),
        CrashError::RoundStillActive
    );
    let bump = ctx.bumps.randomness_authority;
    let accounts = &ctx.accounts;
    // Order of `switchboard::RANDOMNESS_INIT.accounts`.
    let infos = [
        accounts.randomness.to_account_info(),
        accounts.reward_escrow.to_account_info(),
        accounts.randomness_authority.to_account_info(),
        accounts.queue.to_account_info(),
        accounts.admin.to_account_info(),
        accounts.system_program.to_account_info(),
        accounts.token_program.to_account_info(),
        accounts.associated_token_program.to_account_info(),
        accounts.wrapped_sol_mint.to_account_info(),
        accounts.program_state.to_account_info(),
        accounts.lut_signer.to_account_info(),
        accounts.lut.to_account_info(),
        accounts.address_lookup_table_program.to_account_info(),
    ];
    switchboard::invoke(
        &switchboard::RANDOMNESS_INIT,
        &accounts.switchboard_program.to_account_info(),
        &infos,
        &recent_slot.to_le_bytes(),
        &[&[RANDOMNESS_AUTHORITY_SEED, &[bump]]],
    )?;
    switchboard::Randomness::read(
        &accounts.randomness.to_account_info(),
        &accounts.randomness_authority.key(),
    )?;

    let randomness_account = accounts.randomness.key();
    let config = &mut ctx.accounts.config;
    config.randomness_account = randomness_account;
    config.randomness_authority_bump = bump;
    emit!(RandomnessAccountSet { randomness_account });
    Ok(())
}
