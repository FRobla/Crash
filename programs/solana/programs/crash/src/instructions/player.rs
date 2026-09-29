use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::*,
    error::CrashError,
    events::{
        CoinsBought, CoinsSold, PlayerClosed, PlayerRegistered, SessionCreated, SessionRevoked,
        UsernameChanged, UsernameReset,
    },
    state::{HouseConfig, Player, Session, Username, UsernameRecord},
    vault::require_player_funded,
};

#[derive(Accounts)]
#[instruction(username: String)]
pub struct RegisterPlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    /// `init` makes a taken name fail.
    #[account(
        init,
        payer = owner,
        space = 8 + UsernameRecord::INIT_SPACE,
        seeds = [USERNAME_SEED, username.as_bytes()],
        bump
    )]
    pub username_record: Account<'info, UsernameRecord>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_player(ctx: Context<RegisterPlayer>, username: String) -> Result<()> {
    require!(!ctx.accounts.config.paused, CrashError::Paused);
    let name = Username::parse(&username)?;
    let slot = Clock::get()?.slot;
    let owner = ctx.accounts.owner.key();
    ctx.accounts.player.set_inner(Player {
        owner,
        username: name,
        username_changed_slot: slot,
        balance: 0,
        active_bet: None,
        session: None,
        total_wagered: 0,
        bets_settled: 0,
        created_slot: slot,
        bump: ctx.bumps.player,
    });
    ctx.accounts.username_record.set_inner(UsernameRecord {
        owner,
        bump: ctx.bumps.username_record,
    });
    emit!(PlayerRegistered { owner, username });
    Ok(())
}

#[derive(Accounts)]
pub struct BuyCoins<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

/// Coins are a display unit of lamports (1 coin = 10⁶ lamports): buying is a 1:1 deposit.
pub fn handle_buy_coins(ctx: Context<BuyCoins>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, CrashError::Paused);
    require!(amount > 0, CrashError::ZeroAmount);
    let accounts = system_program::Transfer {
        from: ctx.accounts.owner.to_account_info(),
        to: ctx.accounts.player.to_account_info(),
    };
    system_program::transfer(CpiContext::new(system_program::ID, accounts), amount)?;

    let player = &mut ctx.accounts.player;
    player.balance = player
        .balance
        .checked_add(amount)
        .ok_or(CrashError::ArithmeticOverflow)?;
    let balance = player.balance;
    require_player_funded(&ctx.accounts.player.to_account_info(), balance)?;
    emit!(CoinsBought {
        owner: ctx.accounts.owner.key(),
        amount,
        balance
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SellCoins<'info> {
    /// The only possible destination of the lamports.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
}

/// Exit path: never blocked by the pause.
pub fn handle_sell_coins(ctx: Context<SellCoins>, amount: u64) -> Result<()> {
    require!(amount > 0, CrashError::ZeroAmount);
    let player = &mut ctx.accounts.player;
    require!(amount <= player.balance, CrashError::InsufficientBalance);
    player.balance -= amount;
    let balance = player.balance;

    ctx.accounts.player.sub_lamports(amount)?;
    ctx.accounts.owner.add_lamports(amount)?;
    require_player_funded(&ctx.accounts.player.to_account_info(), balance)?;
    emit!(CoinsSold {
        owner: ctx.accounts.owner.key(),
        amount,
        balance
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CreateSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    /// Browser key; it receives `fee_budget` to pay its own transaction fees.
    #[account(mut)]
    pub session_key: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Replaces any previous session (spec v2 §5.1).
pub fn handle_create_session(
    ctx: Context<CreateSession>,
    expires_slot: u64,
    spend_cap: u64,
    fee_budget: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, CrashError::Paused);
    let key = ctx.accounts.session_key.key();
    let owner = ctx.accounts.owner.key();
    let slot = Clock::get()?.slot;
    let latest_expiry = slot
        .checked_add(config.player_policy.max_session_slots)
        .ok_or(CrashError::ArithmeticOverflow)?;
    let valid = key != owner
        && key != Pubkey::default()
        && expires_slot > slot
        && expires_slot <= latest_expiry
        && spend_cap > 0;
    require!(valid, CrashError::InvalidSession);

    ctx.accounts.player.session = Some(Session {
        key,
        expires_slot,
        spend_cap,
        spent: 0,
    });
    if fee_budget > 0 {
        let accounts = system_program::Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: ctx.accounts.session_key.to_account_info(),
        };
        system_program::transfer(CpiContext::new(system_program::ID, accounts), fee_budget)?;
    }
    emit!(SessionCreated {
        owner,
        key,
        expires_slot,
        spend_cap
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    /// The owner or the session key itself, even if expired.
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

/// Exit path: never blocked by the pause.
pub fn handle_revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
    let player = &mut ctx.accounts.player;
    let session = player.session.ok_or(CrashError::NoSession)?;
    player.signer_role(&ctx.accounts.signer.key())?;
    player.session = None;
    emit!(SessionRevoked {
        owner: player.owner,
        key: session.key
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(username: String)]
pub struct ChangeUsername<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
    #[account(
        init,
        payer = owner,
        space = 8 + UsernameRecord::INIT_SPACE,
        seeds = [USERNAME_SEED, username.as_bytes()],
        bump
    )]
    pub new_record: Account<'info, UsernameRecord>,
    /// Record of the current name; required iff the player has one. Its rent goes back to the owner.
    #[account(
        mut,
        seeds = [USERNAME_SEED, player.username.as_bytes()],
        bump = old_record.bump,
        constraint = old_record.owner == owner.key() @ CrashError::UsernameRecordMismatch,
        close = owner
    )]
    pub old_record: Option<Account<'info, UsernameRecord>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_change_username(ctx: Context<ChangeUsername>, username: String) -> Result<()> {
    let name = Username::parse(&username)?;
    let slot = Clock::get()?.slot;
    let player = &mut ctx.accounts.player;
    require!(
        player.username.is_empty() == ctx.accounts.old_record.is_none(),
        CrashError::UsernameRecordMismatch
    );
    let allowed_from = player
        .username_changed_slot
        .saturating_add(ctx.accounts.config.player_policy.username_cooldown_slots);
    require!(slot >= allowed_from, CrashError::UsernameCooldown);

    let old = player.username.to_string_lossy();
    player.username = name;
    player.username_changed_slot = slot;
    ctx.accounts.new_record.set_inner(UsernameRecord {
        owner: player.owner,
        bump: ctx.bumps.new_record,
    });
    emit!(UsernameChanged {
        owner: player.owner,
        old,
        new: username
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResetUsername<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [HOUSE_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(
        mut,
        seeds = [USERNAME_SEED, player.username.as_bytes()],
        bump = username_record.bump,
        constraint = username_record.owner == player.owner @ CrashError::UsernameRecordMismatch,
        close = owner
    )]
    pub username_record: Account<'info, UsernameRecord>,
    /// Receives the record's rent.
    #[account(mut, address = player.owner)]
    pub owner: SystemAccount<'info>,
}

/// Moderation: frees an offensive name. It only touches the name (spec v2 §5.1).
pub fn handle_reset_username(ctx: Context<ResetUsername>) -> Result<()> {
    let player = &mut ctx.accounts.player;
    require!(
        !player.username.is_empty(),
        CrashError::UsernameRecordMismatch
    );
    let old = player.username.to_string_lossy();
    player.username = Username::NONE;
    player.username_changed_slot = Clock::get()?.slot;
    emit!(UsernameReset {
        owner: player.owner,
        old
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClosePlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump = player.bump,
        has_one = owner,
        close = owner
    )]
    pub player: Account<'info, Player>,
    /// Record of the current name; required iff the player has one.
    #[account(
        mut,
        seeds = [USERNAME_SEED, player.username.as_bytes()],
        bump = username_record.bump,
        constraint = username_record.owner == owner.key() @ CrashError::UsernameRecordMismatch,
        close = owner
    )]
    pub username_record: Option<Account<'info, UsernameRecord>>,
}

/// Exit path: never blocked by the pause. Every lamport of the account, donations included,
/// goes to the owner; experience is lost.
pub fn handle_close_player(ctx: Context<ClosePlayer>) -> Result<()> {
    let player = &ctx.accounts.player;
    require!(
        player.balance == 0 && player.active_bet.is_none(),
        CrashError::PlayerNotEmpty
    );
    require!(
        player.username.is_empty() == ctx.accounts.username_record.is_none(),
        CrashError::UsernameRecordMismatch
    );
    emit!(PlayerClosed {
        owner: player.owner
    });
    Ok(())
}
