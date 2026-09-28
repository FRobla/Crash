//! Commitment and entropy derivation (ADR 0002, scheme C; spec §6).

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

use crate::constants::{COMMIT_TAG, ENTROPY_TAG};

pub fn commitment(program_id: &Pubkey, round_id: u64, seed: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        COMMIT_TAG,
        program_id.as_ref(),
        &round_id.to_le_bytes(),
        seed,
    ])
    .to_bytes()
}

pub fn entropy(
    program_id: &Pubkey,
    round_id: u64,
    seed: &[u8; 32],
    vrf_output: &[u8; 32],
) -> [u8; 32] {
    hashv(&[
        ENTROPY_TAG,
        program_id.as_ref(),
        &round_id.to_le_bytes(),
        seed,
        vrf_output,
    ])
    .to_bytes()
}
