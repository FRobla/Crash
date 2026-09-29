use anchor_lang::prelude::*;

use crate::{constants::*, error::CrashError};

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PlayerPolicy {
    /// Longest session a player may open, counted from the creation slot.
    pub max_session_slots: u64,
    /// Minimum slots between two username changes (0 = no cooldown).
    pub username_cooldown_slots: u64,
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
    pub player_policy: PlayerPolicy,
    pub paused: bool,
    pub next_round_id: u64,
    pub current_round: Option<u64>,
    /// Switchboard randomness account controlled by the `randomness_authority` PDA; default = unset.
    pub randomness_account: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub randomness_authority_bump: u8,
}

/// Holds the bank and the stakes in play as lamports; `reserved_exposure` covers every active bet.
/// Player balances never live here: they stay in each `Player` PDA.
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
    /// Switchboard account and commit slot fixed by `close_betting`; `start_round` must match them.
    pub randomness_account: Pubkey,
    pub randomness_seed_slot: u64,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetOutcome {
    CashedOut,
    Lost,
    Refunded,
}

/// A player's bet in play; replaces the v1.1 `Bet` account (spec v2 §3.1).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct ActiveBet {
    pub round_id: u64,
    pub stake: u64,
    /// Auto cash-out target in ten-thousandths; 0 means none.
    pub auto_cash_out: u64,
    pub exposure: u64,
    pub cash_out_tick: Option<u64>,
}

impl ActiveBet {
    pub fn auto_target(&self) -> Option<u64> {
        (self.auto_cash_out != 0).then_some(self.auto_cash_out)
    }
}

/// Browser key allowed to bet and cash out for the player (spec v2 §4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Session {
    pub key: Pubkey,
    pub expires_slot: u64,
    pub spend_cap: u64,
    pub spent: u64,
}

/// Validated username: 3–16 bytes in `[a-z0-9_]`; `len = 0` means no name (spec v2 §3.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Username {
    pub len: u8,
    pub bytes: [u8; USERNAME_MAX_LEN],
}

impl Username {
    pub const NONE: Username = Username {
        len: 0,
        bytes: [0; USERNAME_MAX_LEN],
    };

    /// Rejects anything outside the canonical form instead of normalizing it.
    pub fn parse(name: &str) -> Result<Username> {
        let raw = name.as_bytes();
        let valid = (USERNAME_MIN_LEN..=USERNAME_MAX_LEN).contains(&raw.len())
            && raw
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_');
        require!(valid, CrashError::InvalidUsername);
        let mut bytes = [0; USERNAME_MAX_LEN];
        bytes[..raw.len()].copy_from_slice(raw);
        Ok(Username {
            len: raw.len() as u8,
            bytes,
        })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn to_string_lossy(&self) -> String {
        String::from_utf8_lossy(self.as_bytes()).into_owned()
    }
}

/// Who signed an instruction on behalf of a player.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayerSigner {
    Owner,
    Session,
}

/// Per-wallet account. Its lamports hold `balance` on top of its rent (spec v2 §3.1).
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    pub username: Username,
    pub username_changed_slot: u64,
    /// Free lamports the player can bet or sell; the stake in play is in the vault.
    pub balance: u64,
    pub active_bet: Option<ActiveBet>,
    pub session: Option<Session>,
    /// Stakes settled in `Crashed` rounds, in lamports: the source of experience.
    pub total_wagered: u64,
    pub bets_settled: u64,
    pub created_slot: u64,
    pub bump: u8,
}

impl Player {
    /// The owner, or the current session key regardless of expiry; callers apply the
    /// per-action session limits (spec v2 §4).
    pub fn signer_role(&self, signer: &Pubkey) -> Result<PlayerSigner> {
        if *signer == self.owner {
            return Ok(PlayerSigner::Owner);
        }
        match &self.session {
            Some(session) if session.key == *signer => Ok(PlayerSigner::Session),
            _ => err!(CrashError::Unauthorized),
        }
    }
}

/// Makes a username unique: the account exists iff the name is taken.
#[account]
#[derive(InitSpace)]
pub struct UsernameRecord {
    pub owner: Pubkey,
    pub bump: u8,
}
