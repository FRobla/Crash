use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::*,
    error::CrashError,
    events::{BetPlaced, BetSettled, CashOutRecorded},
    state::{Bet, BetOutcome, BetStatus, HouseConfig, HouseVault, Round, RoundPhase},
    vault::require_covers,
};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, HouseVault>,
    #[account(mut, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// `init` makes a second bet by the same player in the same round fail.
    #[account(
        init,
        payer = player,
        space = 8 + Bet::INIT_SPACE,
        seeds = [BET_SEED, round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump
    )]
    pub bet: Account<'info, Bet>,
    pub system_program: Program<'info, System>,
}

/// `auto_cash_out = 0` means no auto cash-out.
pub fn handle_place_bet(
    ctx: Context<PlaceBet>,
    round_id: u64,
    stake: u64,
    auto_cash_out: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(!config.paused, CrashError::Paused);
    require!(round.phase == RoundPhase::Betting, CrashError::InvalidPhase);
    require!(
        Clock::get()?.slot < round.betting_end_slot,
        CrashError::BettingClosed
    );
    require!(
        round.bet_count < config.max_bets_per_round,
        CrashError::TooManyBets
    );

    let rules =
        crash_rules::rules_for_version(round.rules_version).ok_or(CrashError::RulesError)?;
    let auto = (auto_cash_out != 0).then_some(auto_cash_out);
    let exposure =
        crash_rules::validate_bet(stake, auto, &config.limits.to_rules(), rules.max_multiplier)
            .map_err(CrashError::from)?;
    let total_exposure = round
        .total_exposure
        .checked_add(exposure)
        .ok_or(CrashError::ArithmeticOverflow)?;
    require!(
        total_exposure <= config.limits.max_round_exposure,
        CrashError::RoundExposureExceeded
    );

    let accounts = system_program::Transfer {
        from: ctx.accounts.player.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
    };
    system_program::transfer(CpiContext::new(system_program::ID, accounts), stake)?;

    let vault = &mut ctx.accounts.vault;
    vault.reserved_exposure = vault
        .reserved_exposure
        .checked_add(exposure)
        .ok_or(CrashError::ArithmeticOverflow)?;
    require_covers(&vault.to_account_info(), vault.reserved_exposure)?;

    round.total_exposure = total_exposure;
    round.bet_count += 1;
    ctx.accounts.bet.set_inner(Bet {
        round_id,
        player: ctx.accounts.player.key(),
        stake,
        auto_cash_out,
        exposure,
        cash_out_tick: None,
        status: BetStatus::Active,
        outcome: BetOutcome::Pending,
        settled_multiplier: 0,
        payout: 0,
        bump: ctx.bumps.bet,
    });
    emit!(BetPlaced {
        round_id,
        player: ctx.accounts.player.key(),
        stake,
        auto_cash_out,
        exposure
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    pub player: Signer<'info>,
    #[account(seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [BET_SEED, round.round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump = bet.bump,
        has_one = player
    )]
    pub bet: Account<'info, Bet>,
}

/// Records the authoritative tick (slot of inclusion); it pays nothing while the crash point is secret.
pub fn handle_cash_out(ctx: Context<CashOut>) -> Result<()> {
    let round = &ctx.accounts.round;
    let bet = &mut ctx.accounts.bet;
    require!(round.phase == RoundPhase::Running, CrashError::InvalidPhase);
    require!(
        bet.status == BetStatus::Active,
        CrashError::BetAlreadySettled
    );
    require!(bet.cash_out_tick.is_none(), CrashError::AlreadyCashedOut);

    let rules =
        crash_rules::rules_for_version(round.rules_version).ok_or(CrashError::RulesError)?;
    let tick = Clock::get()?
        .slot
        .checked_sub(round.start_slot)
        .ok_or(CrashError::ArithmeticOverflow)?;
    let multiplier = rules.recognized_at_tick(tick).map_err(CrashError::from)?;
    require!(
        multiplier >= crash_rules::MIN_CASH_OUT_MULTIPLIER,
        CrashError::CashOutTooEarly
    );

    bet.cash_out_tick = Some(tick);
    emit!(CashOutRecorded {
        round_id: round.round_id,
        player: bet.player,
        tick,
        multiplier
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, HouseVault>,
    #[account(
        mut,
        seeds = [BET_SEED, round.round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump = bet.bump,
        has_one = player
    )]
    pub bet: Account<'info, Bet>,
    /// Payouts can only go to the bet's player.
    #[account(mut)]
    pub player: SystemAccount<'info>,
}

/// Permissionless (an operator crank normally calls it); mirrors `settleRound` for one bet.
pub fn handle_settle_bet(ctx: Context<SettleBet>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let bet = &mut ctx.accounts.bet;
    require!(
        bet.status == BetStatus::Active,
        CrashError::BetAlreadySettled
    );

    let rules =
        crash_rules::rules_for_version(round.rules_version).ok_or(CrashError::RulesError)?;
    let outcome = match round.phase {
        RoundPhase::Crashed => crash_rules::settle_bet(
            &rules,
            bet.stake,
            bet.auto_target(),
            bet.cash_out_tick,
            round.crash_point,
        ),
        RoundPhase::Forfeited => crash_rules::settle_forfeited_bet(
            &rules,
            bet.stake,
            bet.auto_target(),
            bet.cash_out_tick,
        ),
        RoundPhase::Voided => Ok(crash_rules::refund_bet(bet.stake)),
        _ => return err!(CrashError::InvalidPhase),
    }
    .map_err(CrashError::from)?;

    let (result, multiplier) = match outcome {
        crash_rules::Outcome::CashedOut { multiplier, .. } => (BetOutcome::CashedOut, multiplier),
        crash_rules::Outcome::Lost => (BetOutcome::Lost, 0),
        crash_rules::Outcome::Refunded { .. } => (BetOutcome::Refunded, 0),
    };
    let payout = outcome.payout();
    // Defense in depth: the reserved exposure bounds every possible payout.
    require!(payout <= bet.exposure, CrashError::ArithmeticOverflow);

    bet.status = BetStatus::Settled;
    bet.outcome = result;
    bet.settled_multiplier = multiplier;
    bet.payout = payout;
    round.settled_count += 1;
    if round.phase == RoundPhase::Crashed && round.settled_count == round.bet_count {
        round.phase = RoundPhase::Settled;
    }

    let vault = &mut ctx.accounts.vault;
    vault.reserved_exposure = vault
        .reserved_exposure
        .checked_sub(bet.exposure)
        .ok_or(CrashError::ArithmeticOverflow)?;
    if payout > 0 {
        vault.sub_lamports(payout)?;
        ctx.accounts.player.add_lamports(payout)?;
    }
    require_covers(&vault.to_account_info(), vault.reserved_exposure)?;

    emit!(BetSettled {
        round_id: round.round_id,
        player: bet.player,
        outcome: result,
        multiplier,
        payout
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBet<'info> {
    #[account(
        mut,
        seeds = [BET_SEED, bet.round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump = bet.bump,
        has_one = player,
        close = player
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub player: SystemAccount<'info>,
}

pub fn handle_close_bet(ctx: Context<CloseBet>) -> Result<()> {
    require!(
        ctx.accounts.bet.status == BetStatus::Settled,
        CrashError::InvalidPhase
    );
    Ok(())
}
