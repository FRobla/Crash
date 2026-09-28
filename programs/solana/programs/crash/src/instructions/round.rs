use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::CrashError,
    events::{
        BettingClosed, RoundForfeited, RoundOpened, RoundRevealed, RoundStarted, RoundVoided,
    },
    randomness,
    state::{HouseConfig, Round, RoundPhase},
    switchboard,
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
    require!(
        config.randomness_account != Pubkey::default(),
        CrashError::RandomnessNotConfigured
    );

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
        randomness_account: Pubkey::default(),
        randomness_seed_slot: 0,
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
    /// CHECK: the house account; owner, discriminator and authority are checked after the CPI.
    #[account(mut, address = config.randomness_account @ CrashError::InvalidRandomnessAccount)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA, never read.
    #[account(seeds = [RANDOMNESS_AUTHORITY_SEED], bump = config.randomness_authority_bump)]
    pub randomness_authority: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (must be the queue of `randomness` and of `oracle`).
    pub queue: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (an oracle of `queue`, chosen by the caller).
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::SLOT_HASHES_SYSVAR)]
    pub recent_slothashes: UncheckedAccount<'info>,
    /// CHECK: pinned Switchboard program id.
    #[account(address = switchboard::PROGRAM_ID @ CrashError::InvalidRandomnessAccount)]
    pub switchboard_program: UncheckedAccount<'info>,
}

/// Permissionless: commits the house randomness account to a slot after betting closed.
pub fn handle_close_betting(ctx: Context<CloseBetting>) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(
        accounts.round.phase == RoundPhase::Betting,
        CrashError::InvalidPhase
    );
    let slot = Clock::get()?.slot;
    require!(
        slot >= accounts.round.betting_end_slot,
        CrashError::BettingStillOpen
    );

    // Order of `switchboard::RANDOMNESS_COMMIT.accounts`.
    let infos = [
        accounts.randomness.to_account_info(),
        accounts.queue.to_account_info(),
        accounts.oracle.to_account_info(),
        accounts.recent_slothashes.to_account_info(),
        accounts.randomness_authority.to_account_info(),
    ];
    switchboard::invoke(
        &switchboard::RANDOMNESS_COMMIT,
        &accounts.switchboard_program.to_account_info(),
        &infos,
        &[],
        &[&[
            RANDOMNESS_AUTHORITY_SEED,
            &[accounts.config.randomness_authority_bump],
        ]],
    )?;
    let committed = switchboard::Randomness::read(
        &accounts.randomness.to_account_info(),
        &accounts.randomness_authority.key(),
    )?;
    // The commit must be to a slot after betting closed (devnet: always `slot - 1`).
    require!(
        committed.seed_slot < slot
            && committed.seed_slot >= accounts.round.betting_end_slot.saturating_sub(1),
        CrashError::StaleRandomness
    );

    let randomness_account = accounts.randomness.key();
    let entropy_timeout_slots = accounts.config.timeouts.entropy_timeout_slots;
    let round = &mut ctx.accounts.round;
    round.randomness_account = randomness_account;
    round.randomness_seed_slot = committed.seed_slot;
    round.entropy_deadline_slot = slot
        .checked_add(entropy_timeout_slots)
        .ok_or(CrashError::ArithmeticOverflow)?;
    round.phase = RoundPhase::AwaitingEntropy;
    emit!(BettingClosed {
        round_id: round.round_id,
        randomness_account,
        randomness_seed_slot: committed.seed_slot,
        entropy_deadline_slot: round.entropy_deadline_slot
    });
    Ok(())
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// Anyone may start the round; they pay as the reveal's `payer`.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the round's account; owner, discriminator and authority are checked after the CPI.
    #[account(mut, address = round.randomness_account @ CrashError::InvalidRandomnessAccount)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA, never read.
    #[account(seeds = [RANDOMNESS_AUTHORITY_SEED], bump = config.randomness_authority_bump)]
    pub randomness_authority: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (the oracle assigned at commit).
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (the oracle's queue).
    pub queue: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (oracle randomness stats PDA).
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (wSOL associated token account of `randomness`).
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: validated by Switchboard (its global state PDA).
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::SLOT_HASHES_SYSVAR)]
    pub recent_slothashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: fixed address.
    #[account(address = switchboard::TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = switchboard::WRAPPED_SOL_MINT)]
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: pinned Switchboard program id.
    #[account(address = switchboard::PROGRAM_ID @ CrashError::InvalidRandomnessAccount)]
    pub switchboard_program: UncheckedAccount<'info>,
}

/// Permissionless: reveals with the gateway's public payload and reads the value in the same slot,
/// so the operator can never learn `vrf_output` first and decide whether the round starts.
pub fn handle_start_round(
    ctx: Context<StartRound>,
    signature: [u8; 64],
    recovery_id: u8,
    value: [u8; 32],
) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(
        accounts.round.phase == RoundPhase::AwaitingEntropy,
        CrashError::InvalidPhase
    );
    let slot = Clock::get()?.slot;
    require!(
        slot <= accounts.round.entropy_deadline_slot,
        CrashError::EntropyDeadlinePassed
    );

    // Order of `switchboard::RANDOMNESS_REVEAL.accounts`.
    let infos = [
        accounts.randomness.to_account_info(),
        accounts.oracle.to_account_info(),
        accounts.queue.to_account_info(),
        accounts.stats.to_account_info(),
        accounts.randomness_authority.to_account_info(),
        accounts.payer.to_account_info(),
        accounts.recent_slothashes.to_account_info(),
        accounts.system_program.to_account_info(),
        accounts.reward_escrow.to_account_info(),
        accounts.token_program.to_account_info(),
        accounts.wrapped_sol_mint.to_account_info(),
        accounts.program_state.to_account_info(),
    ];
    switchboard::invoke(
        &switchboard::RANDOMNESS_REVEAL,
        &accounts.switchboard_program.to_account_info(),
        &infos,
        &switchboard::reveal_args(&signature, recovery_id, &value),
        &[&[
            RANDOMNESS_AUTHORITY_SEED,
            &[accounts.config.randomness_authority_bump],
        ]],
    )?;
    let revealed = switchboard::Randomness::read(
        &accounts.randomness.to_account_info(),
        &accounts.randomness_authority.key(),
    )?;
    require!(
        revealed.seed_slot == accounts.round.randomness_seed_slot && revealed.reveal_slot == slot,
        CrashError::StaleRandomness
    );

    let rules = rules_for(&accounts.round)?;
    let reveal_deadline_slot = slot
        .checked_add(rules.horizon().map_err(CrashError::from)?)
        .and_then(|end| end.checked_add(accounts.config.timeouts.reveal_grace_slots))
        .ok_or(CrashError::ArithmeticOverflow)?;
    let round = &mut ctx.accounts.round;
    round.vrf_output = revealed.value;
    round.start_slot = slot;
    round.reveal_deadline_slot = reveal_deadline_slot;
    round.phase = RoundPhase::Running;
    emit!(RoundStarted {
        round_id: round.round_id,
        vrf_output: revealed.value,
        start_slot: slot,
        reveal_deadline_slot,
    });
    Ok(())
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

/// Only before `running`, while nobody can know the outcome (spec §3). A round stuck in `Betting`
/// (nobody closed it, or the commit keeps failing) becomes permissionless after the entropy timeout.
pub fn handle_void_round(ctx: Context<VoidRound>) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    match round.phase {
        RoundPhase::Betting => {
            let stuck_after = round
                .betting_end_slot
                .checked_add(config.timeouts.entropy_timeout_slots)
                .ok_or(CrashError::ArithmeticOverflow)?;
            require!(
                ctx.accounts.authority.key() == config.operator || Clock::get()?.slot > stuck_after,
                CrashError::OperatorRequired
            );
        }
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
