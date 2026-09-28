//! TEST ONLY — never deploy. Stand-in for Switchboard On-Demand randomness in LiteSVM
//! (docs/specs/crash-program.md §10).
//!
//! It mirrors the pinned IDL (`programs/crash/tests/fixtures/switchboard-randomness-idl.json`):
//! same program id, instruction and account discriminators (Anchor derives them from the same
//! names), account lists with the same signer/writable flags, the same account layout, and the
//! same authority checks. It does NOT verify the oracle signature: the revealed value is whatever
//! the test sends. The real program is only exercised on devnet.

use anchor_lang::prelude::*;

declare_id!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

/// Test hook: a reveal with this recovery id leaves the account untouched, to simulate a reveal
/// that did not update the account in the current slot.
pub const NO_OP_RECOVERY_ID: u8 = u8::MAX;

#[program]
pub mod switchboard_mock {
    use super::*;

    pub fn randomness_init(
        ctx: Context<RandomnessInit>,
        params: RandomnessInitParams,
    ) -> Result<()> {
        let accounts = &ctx.accounts;
        let lamports = Rent::get()?.minimum_balance(ACCOUNT_LEN);
        let create = anchor_lang::system_program::CreateAccount {
            from: accounts.payer.to_account_info(),
            to: accounts.randomness.to_account_info(),
        };
        anchor_lang::system_program::create_account(
            CpiContext::new(anchor_lang::system_program::ID, create),
            lamports,
            ACCOUNT_LEN as u64,
            &crate::ID,
        )?;
        let mut data = accounts.randomness.try_borrow_mut_data()?;
        put(&mut data, 0, &DISCRIMINATOR);
        put(&mut data, AUTHORITY, accounts.authority.key().as_ref());
        put(&mut data, QUEUE, accounts.queue.key().as_ref());
        put(&mut data, LUT_SLOT, &params.recent_slot.to_le_bytes());
        Ok(())
    }

    pub fn randomness_commit(
        ctx: Context<RandomnessCommit>,
        _params: RandomnessCommitParams,
    ) -> Result<()> {
        let accounts = &ctx.accounts;
        let mut data = load_mut(&accounts.randomness, &accounts.authority)?;
        require_keys_eq!(pubkey_at(&data, QUEUE), accounts.queue.key());
        let slot = Clock::get()?.slot;
        // Observed on devnet: the commit binds to the previous slot's hash.
        put(&mut data, SEED_SLOT, &(slot - 1).to_le_bytes());
        put(&mut data, SEED_SLOTHASH, &[0xAB; 32]);
        put(&mut data, ORACLE, accounts.oracle.key().as_ref());
        put(&mut data, REVEAL_SLOT, &0u64.to_le_bytes());
        put(&mut data, VALUE, &[0; 32]);
        Ok(())
    }

    pub fn randomness_reveal(
        ctx: Context<RandomnessReveal>,
        params: RandomnessRevealParams,
    ) -> Result<()> {
        let accounts = &ctx.accounts;
        let mut data = load_mut(&accounts.randomness, &accounts.authority)?;
        require_keys_eq!(pubkey_at(&data, ORACLE), accounts.oracle.key());
        require_keys_eq!(pubkey_at(&data, QUEUE), accounts.queue.key());
        let slot = Clock::get()?.slot;
        require!(u64_at(&data, SEED_SLOT) < slot, MockError::NotRevealable);
        if params.recovery_id == NO_OP_RECOVERY_ID {
            return Ok(());
        }
        put(&mut data, VALUE, &params.value);
        put(&mut data, REVEAL_SLOT, &slot.to_le_bytes());
        // Observed on devnet: the oracle field is cleared after the reveal.
        put(&mut data, ORACLE, &[0; 32]);
        Ok(())
    }
}

#[error_code]
pub enum MockError {
    #[msg("Randomness is not revealable yet")]
    NotRevealable,
    #[msg("Not a randomness account")]
    NotRandomness,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RandomnessInitParams {
    pub recent_slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RandomnessCommitParams {}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RandomnessRevealParams {
    pub signature: [u8; 64],
    pub recovery_id: u8,
    pub value: [u8; 32],
}

/// Byte layout of `RandomnessAccountData` (IDL type, 472 bytes) plus the 8-byte discriminator.
pub const ACCOUNT_LEN: usize = 480;
pub const DISCRIMINATOR: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
const AUTHORITY: usize = 8;
const QUEUE: usize = 40;
const SEED_SLOTHASH: usize = 72;
const SEED_SLOT: usize = 104;
const ORACLE: usize = 112;
const REVEAL_SLOT: usize = 144;
const VALUE: usize = 152;
const LUT_SLOT: usize = 184;

fn put(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

fn pubkey_at(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::try_from(&data[offset..offset + 32]).unwrap()
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Loads a randomness account owned by this program and checks its authority signer.
fn load_mut<'a, 'info>(
    account: &'a AccountInfo<'info>,
    authority: &Signer,
) -> Result<std::cell::RefMut<'a, &'info mut [u8]>> {
    require_keys_eq!(*account.owner, crate::ID);
    let data = account.try_borrow_mut_data()?;
    require!(
        data.len() == ACCOUNT_LEN && data[..8] == DISCRIMINATOR,
        MockError::NotRandomness
    );
    require_keys_eq!(pubkey_at(&data, AUTHORITY), authority.key());
    Ok(data)
}

// Account order and flags follow the IDL; unchecked accounts are not modelled by the mock.

#[derive(Accounts)]
pub struct RandomnessInit<'info> {
    /// CHECK: created here.
    #[account(mut)]
    pub randomness: Signer<'info>,
    /// CHECK: not modelled.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    /// CHECK: not modelled.
    #[account(mut)]
    pub queue: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: not modelled.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub address_lookup_table_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RandomnessCommit<'info> {
    /// CHECK: owner, discriminator and authority checked by `load_mut`.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: compared with the stored queue.
    pub queue: UncheckedAccount<'info>,
    /// CHECK: recorded as the assigned oracle.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub recent_slothashes: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RandomnessReveal<'info> {
    /// CHECK: owner, discriminator and authority checked by `load_mut`.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: compared with the assigned oracle.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: compared with the stored queue.
    pub queue: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: not modelled.
    pub recent_slothashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: not modelled.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: not modelled.
    pub program_state: UncheckedAccount<'info>,
}
