use anchor_lang::prelude::*;

use crate::error::CrashError;

/// Lamports above the account's rent-exempt minimum.
pub fn free_lamports(account: &AccountInfo) -> Result<u64> {
    let rent_minimum = Rent::get()?.minimum_balance(account.data_len());
    Ok(account.lamports().saturating_sub(rent_minimum))
}

/// Solvency invariant (spec §7.1): free vault lamports must cover every reserved exposure.
pub fn require_covers(vault: &AccountInfo, reserved_exposure: u64) -> Result<()> {
    require!(
        free_lamports(vault)? >= reserved_exposure,
        CrashError::InsufficientBank
    );
    Ok(())
}

/// Player funds invariant (spec v2 §7.11): a `Player` account's lamports cover its rent and balance.
pub fn require_player_funded(player: &AccountInfo, balance: u64) -> Result<()> {
    require!(
        free_lamports(player)? >= balance,
        CrashError::InsufficientBalance
    );
    Ok(())
}
