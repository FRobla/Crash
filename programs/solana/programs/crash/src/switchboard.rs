//! Minimal Switchboard On-Demand randomness adapter (ADR 0002 final decision; spec §6.1).
//!
//! Hand-written from the on-chain IDL pinned in `tests/fixtures/switchboard-randomness-idl.json`
//! instead of depending on the `switchboard-on-demand` crate, which pulls in unneeded dependencies
//! and ships no reveal CPI. `tests/switchboard.rs` checks every constant here against that IDL and
//! against a real devnet account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::error::CrashError;

/// Devnet program id. The program targets devnet only (spec §1); mainnet needs a deliberate change.
pub const PROGRAM_ID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

// Fixed-address accounts that Switchboard expects in its randomness instructions.
pub const SLOT_HASHES_SYSVAR: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WRAPPED_SOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const ADDRESS_LOOKUP_TABLE_PROGRAM: Pubkey =
    pubkey!("AddressLookupTab1e1111111111111111111111111");

/// One account of a Switchboard instruction, in IDL order.
#[derive(Clone, Copy, Debug)]
pub struct AccountSpec {
    pub name: &'static str,
    pub signer: bool,
    pub writable: bool,
}

const fn account(name: &'static str, signer: bool, writable: bool) -> AccountSpec {
    AccountSpec {
        name,
        signer,
        writable,
    }
}

/// Discriminator plus account list of one Switchboard instruction.
#[derive(Clone, Copy, Debug)]
pub struct InstructionSpec {
    pub name: &'static str,
    pub discriminator: [u8; 8],
    pub accounts: &'static [AccountSpec],
}

pub const RANDOMNESS_INIT: InstructionSpec = InstructionSpec {
    name: "randomness_init",
    discriminator: [9, 9, 204, 33, 50, 116, 113, 15],
    accounts: &[
        account("randomness", true, true),
        account("reward_escrow", false, true),
        account("authority", true, false),
        account("queue", false, true),
        account("payer", true, true),
        account("system_program", false, false),
        account("token_program", false, false),
        account("associated_token_program", false, false),
        account("wrapped_sol_mint", false, false),
        account("program_state", false, false),
        account("lut_signer", false, false),
        account("lut", false, true),
        account("address_lookup_table_program", false, false),
    ],
};

pub const RANDOMNESS_COMMIT: InstructionSpec = InstructionSpec {
    name: "randomness_commit",
    discriminator: [52, 170, 152, 201, 179, 133, 242, 141],
    accounts: &[
        account("randomness", false, true),
        account("queue", false, false),
        account("oracle", false, true),
        account("recent_slothashes", false, false),
        account("authority", true, false),
    ],
};

pub const RANDOMNESS_REVEAL: InstructionSpec = InstructionSpec {
    name: "randomness_reveal",
    discriminator: [197, 181, 187, 10, 30, 58, 20, 73],
    accounts: &[
        account("randomness", false, true),
        account("oracle", false, false),
        account("queue", false, false),
        account("stats", false, true),
        account("authority", true, false),
        account("payer", true, true),
        account("recent_slothashes", false, false),
        account("system_program", false, false),
        account("reward_escrow", false, true),
        account("token_program", false, false),
        account("wrapped_sol_mint", false, false),
        account("program_state", false, false),
    ],
};

/// `RandomnessAccountData` discriminator and byte offsets, discriminator included.
pub const RANDOMNESS_ACCOUNT_DISCRIMINATOR: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
pub const AUTHORITY_OFFSET: usize = 8;
pub const QUEUE_OFFSET: usize = 40;
pub const SEED_SLOT_OFFSET: usize = 104;
pub const REVEAL_SLOT_OFFSET: usize = 144;
pub const VALUE_OFFSET: usize = 152;
/// Bytes needed to read every field above.
pub const RANDOMNESS_MIN_LEN: usize = VALUE_OFFSET + 32;

/// The fields of a Switchboard randomness account that the program relies on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Randomness {
    pub authority: Pubkey,
    pub queue: Pubkey,
    pub seed_slot: u64,
    pub reveal_slot: u64,
    pub value: [u8; 32],
}

impl Randomness {
    /// `None` unless the account is owned by Switchboard and carries the randomness discriminator
    /// (the crate's own `parse` skips the owner check; spike finding 5).
    pub fn parse(owner: &Pubkey, data: &[u8]) -> Option<Self> {
        if *owner != PROGRAM_ID
            || data.len() < RANDOMNESS_MIN_LEN
            || data[..8] != RANDOMNESS_ACCOUNT_DISCRIMINATOR
        {
            return None;
        }
        let pubkey_at = |offset: usize| Pubkey::try_from(&data[offset..offset + 32]).ok();
        let u64_at = |offset: usize| {
            data[offset..offset + 8]
                .try_into()
                .ok()
                .map(u64::from_le_bytes)
        };
        Some(Self {
            authority: pubkey_at(AUTHORITY_OFFSET)?,
            queue: pubkey_at(QUEUE_OFFSET)?,
            seed_slot: u64_at(SEED_SLOT_OFFSET)?,
            reveal_slot: u64_at(REVEAL_SLOT_OFFSET)?,
            value: data[VALUE_OFFSET..VALUE_OFFSET + 32].try_into().ok()?,
        })
    }

    /// Reads the account and requires it to be controlled by `authority` (the program's PDA).
    pub fn read(account: &AccountInfo, authority: &Pubkey) -> Result<Self> {
        let randomness = Self::parse(account.owner, &account.try_borrow_data()?)
            .ok_or(CrashError::InvalidRandomnessAccount)?;
        require_keys_eq!(
            randomness.authority,
            *authority,
            CrashError::InvalidRandomnessAccount
        );
        Ok(randomness)
    }
}

/// Builds a Switchboard instruction; `keys` follow `spec.accounts` order.
pub fn instruction(spec: &InstructionSpec, keys: &[Pubkey], args: &[u8]) -> Instruction {
    let accounts = spec
        .accounts
        .iter()
        .zip(keys)
        .map(|(account, key)| AccountMeta {
            pubkey: *key,
            is_signer: account.signer,
            is_writable: account.writable,
        })
        .collect();
    let mut data = Vec::with_capacity(8 + args.len());
    data.extend_from_slice(&spec.discriminator);
    data.extend_from_slice(args);
    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data,
    }
}

/// CPI into Switchboard. `accounts` follow `spec.accounts` order; the program account is checked
/// here as well as by the caller's `address` constraint.
pub fn invoke<'info>(
    spec: &InstructionSpec,
    switchboard_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    args: &[u8],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(
        switchboard_program.key(),
        PROGRAM_ID,
        CrashError::InvalidRandomnessAccount
    );
    require_eq!(
        accounts.len(),
        spec.accounts.len(),
        CrashError::InvalidRandomnessAccount
    );
    let keys: Vec<Pubkey> = accounts.iter().map(|account| account.key()).collect();
    let ix = instruction(spec, &keys, args);
    let mut infos = accounts.to_vec();
    infos.push(switchboard_program.clone());
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// Borsh encoding of `RandomnessRevealParams { signature, recovery_id, value }`.
pub fn reveal_args(signature: &[u8; 64], recovery_id: u8, value: &[u8; 32]) -> Vec<u8> {
    let mut args = Vec::with_capacity(97);
    args.extend_from_slice(signature);
    args.push(recovery_id);
    args.extend_from_slice(value);
    args
}
