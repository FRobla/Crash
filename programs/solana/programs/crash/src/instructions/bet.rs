use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::CrashError,
    events::{BetPlaced, BetSettled, CashOutRecorded},
    state::{
        ActiveBet, BetOutcome, HouseConfig, HouseVault, Player, PlayerSigner, Round, RoundPhase,
    },
    vault::{require_covers, require_player_funded},
};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct PlaceBet<'info> {
    /// The player's wallet or its session key (spec v2 §4).
    pub signer: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, HouseVault>,
    #[account(mut, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

/// Moves the stake from the player's balance to the vault. `auto_cash_out = 0` means none.
pub fn handle_place_bet(
    ctx: Context<PlaceBet>,
    round_id: u64,
    stake: u64,
    auto_cash_out: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    let player = &mut ctx.accounts.player;
    let slot = Clock::get()?.slot;
    require!(!config.paused, CrashError::Paused);
    require!(round.phase == RoundPhase::Betting, CrashError::InvalidPhase);
    require!(slot < round.betting_end_slot, CrashError::BettingClosed);
    require!(
        round.bet_count < config.max_bets_per_round,
        CrashError::TooManyBets
    );

    let by_session = player.signer_role(&ctx.accounts.signer.key())? == PlayerSigner::Session;
    if by_session {
        let session = player.session.as_mut().ok_or(CrashError::NoSession)?;
        require!(slot <= session.expires_slot, CrashError::SessionExpired);
        let spent = session
            .spent
            .checked_add(stake)
            .ok_or(CrashError::ArithmeticOverflow)?;
        require!(
            spent <= session.spend_cap,
            CrashError::SessionSpendCapExceeded
        );
        session.spent = spent;
    }
    require!(player.active_bet.is_none(), CrashError::ActiveBetPending);
    require!(stake <= player.balance, CrashError::InsufficientBalance);

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

    player.balance -= stake;
    player.active_bet = Some(ActiveBet {
        round_id,
        stake,
        auto_cash_out,
        exposure,
        cash_out_tick: None,
    });
    round.total_exposure = total_exposure;
    round.bet_count += 1;
    let (owner, balance) = (player.owner, player.balance);

    // Both accounts belong to the program: lamports move directly, without a CPI.
    ctx.accounts.player.sub_lamports(stake)?;
    ctx.accounts.vault.add_lamports(stake)?;
    require_player_funded(&ctx.accounts.player.to_account_info(), balance)?;

    let vault = &mut ctx.accounts.vault;
    vault.reserved_exposure = vault
        .reserved_exposure
        .checked_add(exposure)
        .ok_or(CrashError::ArithmeticOverflow)?;
    require_covers(&vault.to_account_info(), vault.reserved_exposure)?;

    emit!(BetPlaced {
        round_id,
        player: owner,
        stake,
        auto_cash_out,
        exposure,
        by_session,
        balance
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    /// The player's wallet or its session key, even if expired (spec v2 §4).
    pub signer: Signer<'info>,
    #[account(seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

/// Records the authoritative tick (slot of inclusion); it pays nothing while the crash point is secret.
pub fn handle_cash_out(ctx: Context<CashOut>) -> Result<()> {
    let round = &ctx.accounts.round;
    let player = &mut ctx.accounts.player;
    player.signer_role(&ctx.accounts.signer.key())?;
    require!(round.phase == RoundPhase::Running, CrashError::InvalidPhase);
    let bet = player.active_bet.as_mut().ok_or(CrashError::NoActiveBet)?;
    require!(bet.round_id == round.round_id, CrashError::BetRoundMismatch);
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
        player: player.owner,
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
    /// Payouts can only go to the `Player` account that owns the bet.
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

/// Permissionless (an operator crank normally calls it); mirrors `settleRound` for one bet.
pub fn handle_settle_bet(ctx: Context<SettleBet>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let player = &mut ctx.accounts.player;
    let bet = player.active_bet.ok_or(CrashError::NoActiveBet)?;
    require!(bet.round_id == round.round_id, CrashError::BetRoundMismatch);

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

    player.active_bet = None;
    player.balance = player
        .balance
        .checked_add(payout)
        .ok_or(CrashError::ArithmeticOverflow)?;
    // Only revealed rounds earn experience; void and forfeit refunds carry no risk (ADR 0003 §5).
    if round.phase == RoundPhase::Crashed {
        player.total_wagered = player
            .total_wagered
            .checked_add(bet.stake)
            .ok_or(CrashError::ArithmeticOverflow)?;
        player.bets_settled += 1;
    }
    round.settled_count += 1;
    let event = BetSettled {
        round_id: round.round_id,
        player: player.owner,
        stake: bet.stake,
        auto_cash_out: bet.auto_cash_out,
        cash_out_tick: bet.cash_out_tick,
        outcome: result,
        multiplier,
        payout,
        balance: player.balance,
        total_wagered: player.total_wagered,
    };
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
    require_covers(
        &ctx.accounts.vault.to_account_info(),
        ctx.accounts.vault.reserved_exposure,
    )?;
    require_player_funded(&ctx.accounts.player.to_account_info(), event.balance)?;

    emit!(event);
    Ok(())
}
