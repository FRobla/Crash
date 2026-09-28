use anchor_lang::prelude::*;

use crate::error::CrashError;

/// Lamports above the vault's rent-exempt minimum.
pub fn free_lamports(vault: &AccountInfo) -> Result<u64> {
    let rent_minimum = Rent::get()?.minimum_balance(vault.data_len());
    Ok(vault.lamports().saturating_sub(rent_minimum))
}

/// Solvency invariant (spec §7.1): free lamports must cover every reserved exposure.
pub fn require_covers(vault: &AccountInfo, reserved_exposure: u64) -> Result<()> {
    require!(
        free_lamports(vault)? >= reserved_exposure,
        CrashError::InsufficientBank
    );
    Ok(())
}
