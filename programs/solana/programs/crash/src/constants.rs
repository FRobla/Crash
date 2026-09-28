use anchor_lang::prelude::*;

#[constant]
pub const HOUSE_SEED: &[u8] = b"house";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const ROUND_SEED: &[u8] = b"round";
#[constant]
pub const BET_SEED: &[u8] = b"bet";

/// Domain-separation tags for the randomness scheme (ADR 0002, spec §6).
pub const COMMIT_TAG: &[u8] = b"crash/v1/commit";
pub const ENTROPY_TAG: &[u8] = b"crash/v1/entropy";

/// The only rules version this program implements.
pub const RULES_VERSION: u16 = 1;

/// PDA that owns the house's Switchboard randomness account (ADR 0002, final decision 2).
#[constant]
pub const RANDOMNESS_AUTHORITY_SEED: &[u8] = b"randomness_authority";
