use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::CrashError,
    events::{BettingClosed, RoundForfeited, RoundOpened, RoundRevealed, RoundVoided},
    randomness,
    state::{HouseConfig, Round, RoundPhase},
};

fn rules_for(round: &Round) -> Result<crash_rules::Rules> {
    crash_rules::rules_for_version(round.rules_version)
        .ok_or_else(|| error!(CrashError::RulesError))
}

#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump, has_one = operator)]
    pub config: Account<'info, HouseConfig>,
    #[account(
        init,
        payer = operator,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, config.next_round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

/// `commit = SHA256(COMMIT_TAG ‖ program_id ‖ round_id_le ‖ seed)`; the seed stays off-chain until reveal.
pub fn handle_open_round(ctx: Context<OpenRound>, commit: [u8; 32]) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.paused, CrashError::Paused);
    require!(config.current_round.is_none(), CrashError::RoundStillActive);
    require!(commit != [0u8; 32], CrashError::EmptyCommitment);

    let slot = Clock::get()?.slot;
    let round_id = config.next_round_id;
    let betting_end_slot = slot
        .checked_add(config.timeouts.betting_slots)
        .ok_or(CrashError::ArithmeticOverflow)?;
    ctx.accounts.round.set_inner(Round {
        round_id,
        rules_version: config.rules_version,
        phase: RoundPhase::Betting,
        commit,
        opened_slot: slot,
        betting_end_slot,
        entropy_deadline_slot: 0,
        start_slot: 0,
        reveal_deadline_slot: 0,
        vrf_output: [0; 32],
        seed: [0; 32],
        crash_point: 0,
        crash_tick: 0,
        total_exposure: 0,
        bet_count: 0,
        settled_count: 0,
        bump: ctx.bumps.round,
    });
    config.current_round = Some(round_id);
    config.next_round_id = round_id
        .checked_add(1)
        .ok_or(CrashError::ArithmeticOverflow)?;
    emit!(RoundOpened {
        round_id,
        commit,
        betting_end_slot
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBetting<'info> {
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn handle_close_betting(ctx: Context<CloseBetting>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.phase == RoundPhase::Betting, CrashError::InvalidPhase);
    let slot = Clock::get()?.slot;
    require!(slot >= round.betting_end_slot, CrashError::BettingStillOpen);
    round.entropy_deadline_slot = slot
        .checked_add(ctx.accounts.config.timeouts.entropy_timeout_slots)
        .ok_or(CrashError::ArithmeticOverflow)?;
    round.phase = RoundPhase::AwaitingEntropy;
    // The VRF request belongs here once the provider is chosen (docs/spikes/vrf-devnet.md).
    emit!(BettingClosed {
        round_id: round.round_id,
        entropy_deadline_slot: round.entropy_deadline_slot
    });
    Ok(())
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

/// Blocked until the VRF provider is chosen: it must read and verify the provider's output bound
/// to this round, set `start_slot` and `reveal_deadline_slot`, and require `slot <= entropy_deadline_slot`.
pub fn handle_start_round(_ctx: Context<StartRound>) -> Result<()> {
    err!(CrashError::EntropyProviderNotConfigured)
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

/// Permissionless: the seed itself is the authorization.
pub fn handle_reveal(ctx: Context<Reveal>, seed: [u8; 32]) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.phase == RoundPhase::Running, CrashError::InvalidPhase);
    require!(
        randomness::commitment(&crate::ID, round.round_id, &seed) == round.commit,
        CrashError::CommitmentMismatch
    );
    let slot = Clock::get()?.slot;
    // After the deadline only `forfeit_round` applies, so the outcome never depends on a race.
    require!(
        slot <= round.reveal_deadline_slot,
        CrashError::RevealDeadlinePassed
    );

    let rules = rules_for(round)?;
    let entropy = randomness::entropy(&crate::ID, round.round_id, &seed, &round.vrf_output);
    let crash_point = rules
        .crash_point_from_entropy(&entropy)
        .map_err(CrashError::from)?;
    let crash_tick = rules.crash_tick(crash_point).map_err(CrashError::from)?;
    // Revealing before the curve reaches the crash point would cut off winning cash-outs.
    let tick = slot
        .checked_sub(round.start_slot)
        .ok_or(CrashError::ArithmeticOverflow)?;
    require!(tick >= crash_tick, CrashError::RevealTooEarly);

    round.seed = seed;
    round.crash_point = crash_point;
    round.crash_tick = crash_tick;
    round.phase = if round.bet_count == 0 {
        RoundPhase::Settled
    } else {
        RoundPhase::Crashed
    };
    ctx.accounts.config.current_round = None;
    emit!(RoundRevealed {
        round_id: round.round_id,
        seed,
        vrf_output: round.vrf_output,
        crash_point,
        crash_tick,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct VoidRound<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

/// Only before `running`, while nobody can know the outcome (spec §3).
pub fn handle_void_round(ctx: Context<VoidRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    match round.phase {
        RoundPhase::Betting => require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.operator,
            CrashError::OperatorRequired
        ),
        RoundPhase::AwaitingEntropy => {
            require!(
                Clock::get()?.slot > round.entropy_deadline_slot,
                CrashError::DeadlineNotReached
            )
        }
        _ => return err!(CrashError::InvalidPhase),
    }
    round.phase = RoundPhase::Voided;
    ctx.accounts.config.current_round = None;
    emit!(RoundVoided {
        round_id: round.round_id
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ForfeitRound<'info> {
    #[account(mut, seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn handle_forfeit_round(ctx: Context<ForfeitRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.phase == RoundPhase::Running, CrashError::InvalidPhase);
    require!(
        Clock::get()?.slot > round.reveal_deadline_slot,
        CrashError::DeadlineNotReached
    );
    round.phase = RoundPhase::Forfeited;
    ctx.accounts.config.current_round = None;
    emit!(RoundForfeited {
        round_id: round.round_id
    });
    Ok(())
}
