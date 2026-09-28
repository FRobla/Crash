//! LiteSVM tests of the Crash program (docs/specs/crash-program.md §7–§10).
//!
//! Switchboard is replaced by the test-only mock in `test-programs/switchboard-mock`, loaded at the
//! devnet program id. It runs the same commit/reveal account checks but lets the test choose the
//! revealed value; the oracle signature is only verified by the real program on devnet.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    crash::{
        error::CrashError, randomness, switchboard, Bet, BetOutcome, HouseConfig, HouseVault,
        Limits, Round, RoundPhase, Timeouts,
    },
    litesvm::LiteSVM,
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
const LIMITS: Limits = Limits {
    min_stake: SOL / 1_000,
    max_stake: SOL,
    max_payout: 100 * SOL,
    max_round_exposure: 1_000 * SOL,
};
const TIMEOUTS: Timeouts = Timeouts {
    betting_slots: 25,
    entropy_timeout_slots: 150,
    reveal_grace_slots: 150,
};
const MAX_BETS: u32 = 256;
const RULES: crash_rules::Rules = crash_rules::CRASH_RULES_V1;
const VRF_OUTPUT: [u8; 32] = [7; 32];

/// Stand-ins for Switchboard's queue and oracle; the mock only compares them with what it stored.
const QUEUE: Pubkey = Pubkey::new_from_array([0xA1; 32]);
const ORACLE: Pubkey = Pubkey::new_from_array([0xA2; 32]);

struct Harness {
    svm: LiteSVM,
    admin: Keypair,
    operator: Keypair,
    randomness: Pubkey,
}

fn randomness_authority_pda() -> Pubkey {
    pda(&[crash::RANDOMNESS_AUTHORITY_SEED])
}

fn deployed(name: &str) -> Vec<u8> {
    let path = format!("{}/../deploy/{name}.so", env!("CARGO_TARGET_TMPDIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("{path} missing: build it first (CLAUDE.md)"))
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &crash::ID).0
}

fn config_pda() -> Pubkey {
    pda(&[crash::HOUSE_SEED])
}

fn vault_pda() -> Pubkey {
    pda(&[crash::VAULT_SEED])
}

fn round_pda(round_id: u64) -> Pubkey {
    pda(&[crash::ROUND_SEED, &round_id.to_le_bytes()])
}

fn bet_pda(round_id: u64, player: &Pubkey) -> Pubkey {
    pda(&[crash::BET_SEED, &round_id.to_le_bytes(), player.as_ref()])
}

fn program_data_pda() -> Pubkey {
    Pubkey::find_program_address(
        &[crash::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

fn custom(error: CrashError) -> u32 {
    u32::from(error)
}

impl Harness {
    /// House initialized and its randomness account created, as on devnet.
    fn new() -> Self {
        let mut harness = Self::without_randomness();
        let randomness = Keypair::new();
        let admin = harness.admin.insecure_clone();
        harness.send_ok(
            harness.create_randomness_ix(&admin.pubkey(), &randomness.pubkey()),
            &[&admin, &randomness],
        );
        harness.randomness = randomness.pubkey();
        harness
    }

    fn without_randomness() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(crash::ID, &deployed("crash")).unwrap();
        svm.add_program(switchboard::PROGRAM_ID, &deployed("switchboard_mock"))
            .unwrap();
        let admin = Keypair::new();
        let operator = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000 * SOL).unwrap();
        svm.airdrop(&operator.pubkey(), 10 * SOL).unwrap();

        // LiteSVM deploys without an upgrade authority; make the admin the authority, as on devnet.
        let program_data = program_data_pda();
        let mut account = svm.get_account(&program_data).unwrap();
        account.data[12] = 1;
        account.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(program_data, account).unwrap();

        let mut harness = Harness {
            svm,
            admin,
            operator,
            randomness: Pubkey::default(),
        };
        harness.send_ok(
            harness.initialize_ix(&harness.admin.pubkey()),
            &[&harness.admin.insecure_clone()],
        );
        harness
    }

    fn player(&mut self) -> Keypair {
        let player = Keypair::new();
        self.svm.airdrop(&player.pubkey(), 100 * SOL).unwrap();
        player
    }

    /// Compute units consumed on success, the custom error code on failure.
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<u64, u32> {
        let payer = signers[0].pubkey();
        let message =
            Message::new_with_blockhash(&[ix], Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => {
                self.assert_solvent();
                Ok(meta.compute_units_consumed)
            }
            Err(failure) => match failure.err {
                TransactionError::InstructionError(_, InstructionError::Custom(code)) => Err(code),
                other => panic!("unexpected failure {other:?}\n{:#?}", failure.meta.logs),
            },
        }
    }

    fn send_ok(&mut self, ix: Instruction, signers: &[&Keypair]) -> u64 {
        self.send(ix, signers)
            .unwrap_or_else(|code| panic!("transaction failed with custom error {code}"))
    }

    fn expect_err(&mut self, ix: Instruction, signers: &[&Keypair], error: CrashError) {
        assert_eq!(
            self.send(ix, signers),
            Err(custom(error)),
            "expected {error:?}"
        );
    }

    fn fetch<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).expect("account exists");
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm
            .get_account(address)
            .map_or(0, |account| account.lamports)
    }

    /// Invariant 1: free vault lamports always cover the reserved exposure.
    fn assert_solvent(&self) {
        let Some(account) = self.svm.get_account(&vault_pda()) else {
            return;
        };
        let vault: HouseVault = self.fetch(&vault_pda());
        let free = account.lamports
            - self
                .svm
                .minimum_balance_for_rent_exemption(account.data.len());
        assert!(
            free >= vault.reserved_exposure,
            "vault insolvent: {free} < {}",
            vault.reserved_exposure
        );
    }

    fn slot(&self) -> u64 {
        self.svm
            .get_sysvar::<anchor_lang::solana_program::clock::Clock>()
            .slot
    }

    fn warp(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
    }

    // ---- instruction builders ----

    fn initialize_ix(&self, admin: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::InitializeHouse {
                operator: self.operator.pubkey(),
                limits: LIMITS,
                timeouts: TIMEOUTS,
                max_bets_per_round: MAX_BETS,
            }
            .data(),
            crash::accounts::InitializeHouse {
                admin: *admin,
                config: config_pda(),
                vault: vault_pda(),
                program: crash::ID,
                program_data: program_data_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn update_config_ix(&self, max_bets_per_round: u32, paused: bool) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::UpdateConfig {
                operator: self.operator.pubkey(),
                limits: LIMITS,
                timeouts: TIMEOUTS,
                max_bets_per_round,
                paused,
            }
            .data(),
            crash::accounts::UpdateConfig {
                admin: self.admin.pubkey(),
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    fn deposit_ix(&self, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::DepositBank { amount }.data(),
            crash::accounts::DepositBank {
                admin: self.admin.pubkey(),
                config: config_pda(),
                vault: vault_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn withdraw_ix(&self, admin: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::WithdrawBank { amount }.data(),
            crash::accounts::WithdrawBank {
                admin: *admin,
                config: config_pda(),
                vault: vault_pda(),
            }
            .to_account_metas(None),
        )
    }

    fn open_round_ix(&self, operator: &Pubkey, round_id: u64, commit: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::OpenRound { commit }.data(),
            crash::accounts::OpenRound {
                operator: *operator,
                config: config_pda(),
                round: round_pda(round_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn place_bet_ix(
        &self,
        player: &Pubkey,
        round_id: u64,
        stake: u64,
        auto_cash_out: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::PlaceBet {
                round_id,
                stake,
                auto_cash_out,
            }
            .data(),
            crash::accounts::PlaceBet {
                player: *player,
                config: config_pda(),
                vault: vault_pda(),
                round: round_pda(round_id),
                bet: bet_pda(round_id, player),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn create_randomness_ix(&self, admin: &Pubkey, randomness: &Pubkey) -> Instruction {
        self.create_randomness_ix_with(admin, randomness, &switchboard::PROGRAM_ID)
    }

    fn create_randomness_ix_with(
        &self,
        admin: &Pubkey,
        randomness: &Pubkey,
        switchboard_program: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CreateRandomnessAccount { recent_slot: 1 }.data(),
            crash::accounts::CreateRandomnessAccount {
                admin: *admin,
                config: config_pda(),
                randomness: *randomness,
                randomness_authority: randomness_authority_pda(),
                reward_escrow: Pubkey::new_unique(),
                queue: QUEUE,
                program_state: Pubkey::new_unique(),
                lut_signer: Pubkey::new_unique(),
                lut: Pubkey::new_unique(),
                system_program: system_program::ID,
                token_program: switchboard::TOKEN_PROGRAM,
                associated_token_program: switchboard::ASSOCIATED_TOKEN_PROGRAM,
                wrapped_sol_mint: switchboard::WRAPPED_SOL_MINT,
                address_lookup_table_program: switchboard::ADDRESS_LOOKUP_TABLE_PROGRAM,
                switchboard_program: *switchboard_program,
            }
            .to_account_metas(None),
        )
    }

    fn close_betting_ix(&self, round_id: u64) -> Instruction {
        self.close_betting_ix_with(round_id, &self.randomness, &switchboard::PROGRAM_ID)
    }

    fn close_betting_ix_with(
        &self,
        round_id: u64,
        randomness: &Pubkey,
        switchboard_program: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CloseBetting {}.data(),
            crash::accounts::CloseBetting {
                config: config_pda(),
                round: round_pda(round_id),
                randomness: *randomness,
                randomness_authority: randomness_authority_pda(),
                queue: QUEUE,
                oracle: ORACLE,
                recent_slothashes: switchboard::SLOT_HASHES_SYSVAR,
                switchboard_program: *switchboard_program,
            }
            .to_account_metas(None),
        )
    }

    fn start_round_ix(&self, payer: &Pubkey, round_id: u64, value: [u8; 32]) -> Instruction {
        self.start_round_ix_with(payer, round_id, value, 0, &switchboard::PROGRAM_ID)
    }

    fn start_round_ix_with(
        &self,
        payer: &Pubkey,
        round_id: u64,
        value: [u8; 32],
        recovery_id: u8,
        switchboard_program: &Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::StartRound {
                signature: [0; 64],
                recovery_id,
                value,
            }
            .data(),
            crash::accounts::StartRound {
                config: config_pda(),
                round: round_pda(round_id),
                payer: *payer,
                randomness: self.randomness,
                randomness_authority: randomness_authority_pda(),
                oracle: ORACLE,
                queue: QUEUE,
                stats: Pubkey::new_unique(),
                reward_escrow: Pubkey::new_unique(),
                program_state: Pubkey::new_unique(),
                recent_slothashes: switchboard::SLOT_HASHES_SYSVAR,
                system_program: system_program::ID,
                token_program: switchboard::TOKEN_PROGRAM,
                wrapped_sol_mint: switchboard::WRAPPED_SOL_MINT,
                switchboard_program: *switchboard_program,
            }
            .to_account_metas(None),
        )
    }

    fn cash_out_ix(&self, player: &Pubkey, bet_owner: &Pubkey, round_id: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CashOut {}.data(),
            crash::accounts::CashOut {
                player: *player,
                round: round_pda(round_id),
                bet: bet_pda(round_id, bet_owner),
            }
            .to_account_metas(None),
        )
    }

    fn reveal_ix(&self, round_id: u64, seed: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::Reveal { seed }.data(),
            crash::accounts::Reveal {
                config: config_pda(),
                round: round_pda(round_id),
            }
            .to_account_metas(None),
        )
    }

    fn settle_ix(&self, round_id: u64, bet_owner: &Pubkey, recipient: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::SettleBet {}.data(),
            crash::accounts::SettleBet {
                round: round_pda(round_id),
                vault: vault_pda(),
                bet: bet_pda(round_id, bet_owner),
                player: *recipient,
            }
            .to_account_metas(None),
        )
    }

    fn void_ix(&self, authority: &Pubkey, round_id: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::VoidRound {}.data(),
            crash::accounts::VoidRound {
                authority: *authority,
                config: config_pda(),
                round: round_pda(round_id),
            }
            .to_account_metas(None),
        )
    }

    fn forfeit_ix(&self, round_id: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::ForfeitRound {}.data(),
            crash::accounts::ForfeitRound {
                config: config_pda(),
                round: round_pda(round_id),
            }
            .to_account_metas(None),
        )
    }

    fn close_bet_ix(&self, round_id: u64, player: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CloseBet {}.data(),
            crash::accounts::CloseBet {
                bet: bet_pda(round_id, player),
                player: *player,
            }
            .to_account_metas(None),
        )
    }

    // ---- flows ----

    fn deposit(&mut self, amount: u64) {
        let admin = self.admin.insecure_clone();
        self.send_ok(self.deposit_ix(amount), &[&admin]);
    }

    fn open_round(&mut self, seed: [u8; 32]) -> u64 {
        let config: HouseConfig = self.fetch(&config_pda());
        let round_id = config.next_round_id;
        let operator = self.operator.insecure_clone();
        let commit = randomness::commitment(&crash::ID, round_id, &seed);
        self.send_ok(
            self.open_round_ix(&operator.pubkey(), round_id, commit),
            &[&operator],
        );
        round_id
    }

    fn bet(&mut self, player: &Keypair, round_id: u64, stake: u64, auto_cash_out: u64) {
        self.send_ok(
            self.place_bet_ix(&player.pubkey(), round_id, stake, auto_cash_out),
            &[player],
        );
    }

    fn close_betting(&mut self, round_id: u64) {
        let round: Round = self.fetch(&round_pda(round_id));
        self.warp(round.betting_end_slot);
        let operator = self.operator.insecure_clone();
        self.send_ok(self.close_betting_ix(round_id), &[&operator]);
    }

    /// Reveals `VRF_OUTPUT` through the Switchboard mock a couple of slots after the commit.
    fn start_round(&mut self, round_id: u64) -> u64 {
        let start_slot = self.slot() + 2;
        self.warp(start_slot);
        let operator = self.operator.insecure_clone();
        self.send_ok(
            self.start_round_ix(&operator.pubkey(), round_id, VRF_OUTPUT),
            &[&operator],
        );
        start_slot
    }

    fn randomness_state(&self) -> switchboard::Randomness {
        let account = self.svm.get_account(&self.randomness).unwrap();
        switchboard::Randomness::parse(&account.owner, &account.data).expect("randomness account")
    }

    /// Overwrites a field of the randomness account, as a stand-in for a stale or foreign commit.
    fn patch_randomness(&mut self, offset: usize, bytes: &[u8]) {
        let mut account = self.svm.get_account(&self.randomness).unwrap();
        account.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(self.randomness, account).unwrap();
    }

    fn warp_to_tick(&mut self, round_id: u64, tick: u64) {
        let round: Round = self.fetch(&round_pda(round_id));
        self.warp(round.start_slot + tick);
    }
}

/// Seed whose crash point for `round_id` falls strictly between the two multipliers.
fn seed_with_crash_between(round_id: u64, low: u64, high: u64) -> ([u8; 32], u64) {
    (0u8..=255)
        .map(|index| [index; 32])
        .map(|seed| {
            let entropy = randomness::entropy(&crash::ID, round_id, &seed, &VRF_OUTPUT);
            (seed, RULES.crash_point_from_entropy(&entropy).unwrap())
        })
        .find(|(_, crash_point)| *crash_point > low && *crash_point < high)
        .expect("a seed in range")
}

#[test]
fn initialize_is_reserved_to_the_upgrade_authority() {
    let mut svm_harness = Harness::new();
    let config: HouseConfig = svm_harness.fetch(&config_pda());
    assert_eq!(config.admin, svm_harness.admin.pubkey());
    assert_eq!(config.operator, svm_harness.operator.pubkey());
    assert_eq!(config.rules_version, 1);
    assert_eq!(config.current_round, None);

    // A fresh deployment where an attacker tries to take the admin role first.
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/crash.so"));
    svm.add_program(crash::ID, bytes).unwrap();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), SOL).unwrap();
    svm_harness.svm = svm;
    let result = svm_harness.send(svm_harness.initialize_ix(&attacker.pubkey()), &[&attacker]);
    assert_eq!(result, Err(custom(CrashError::InvalidConfig)));
}

#[test]
fn withdrawals_never_touch_reserved_exposure() {
    let mut h = Harness::new();
    h.deposit(200 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player();
    h.bet(&player, round_id, SOL, 0); // exposure: 1 SOL · 100x = 100 SOL

    let admin = h.admin.insecure_clone();
    let vault: HouseVault = h.fetch(&vault_pda());
    assert_eq!(vault.reserved_exposure, 100 * SOL);
    // Free lamports = 200 (bank) + 1 (stake) = 201 SOL; available = 201 - 100 reserved = 101 SOL.
    h.expect_err(
        h.withdraw_ix(&admin.pubkey(), 101 * SOL + 1),
        &[&admin],
        CrashError::WithdrawalExceedsAvailable,
    );
    h.send_ok(h.withdraw_ix(&admin.pubkey(), 101 * SOL), &[&admin]);

    let stranger = h.player();
    assert!(h
        .send(h.withdraw_ix(&stranger.pubkey(), 1), &[&stranger])
        .is_err());
}

#[test]
fn open_round_guards() {
    let mut h = Harness::new();
    let stranger = h.player();
    assert!(h
        .send(
            h.open_round_ix(&stranger.pubkey(), 0, [1; 32]),
            &[&stranger]
        )
        .is_err());

    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 0, [0; 32]),
        &[&operator],
        CrashError::EmptyCommitment,
    );

    let admin = h.admin.insecure_clone();
    h.send_ok(h.update_config_ix(MAX_BETS, true), &[&admin]);
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 0, [1; 32]),
        &[&operator],
        CrashError::Paused,
    );
    h.send_ok(h.update_config_ix(MAX_BETS, false), &[&admin]);

    let round_id = h.open_round([1; 32]);
    assert_eq!(round_id, 0);
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 1, [2; 32]),
        &[&operator],
        CrashError::RoundStillActive,
    );
}

#[test]
fn place_bet_enforces_limits_window_and_solvency() {
    let mut h = Harness::new();
    let round_id = h.open_round([1; 32]);
    let player = h.player();

    // Empty bank: the vault cannot cover the exposure.
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL, 0),
        &[&player],
        CrashError::InsufficientBank,
    );
    h.deposit(500 * SOL);

    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, LIMITS.min_stake - 1, 0),
        &[&player],
        CrashError::StakeBelowMinimum,
    );
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL + 1, 0),
        &[&player],
        CrashError::StakeAboveMaximum,
    );
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL, 15_050),
        &[&player],
        CrashError::AutoCashOutNotCentiPrecise,
    );
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL, 10_000),
        &[&player],
        CrashError::AutoCashOutBelowMinimum,
    );
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL, 1_000_100),
        &[&player],
        CrashError::AutoCashOutAboveMaximum,
    );

    let before = h.lamports(&player.pubkey());
    h.bet(&player, round_id, SOL, 20_000);
    assert!(before - h.lamports(&player.pubkey()) >= SOL);
    let bet: Bet = h.fetch(&bet_pda(round_id, &player.pubkey()));
    assert_eq!(
        (bet.stake, bet.auto_cash_out, bet.exposure),
        (SOL, 20_000, 2 * SOL)
    );

    // A second bet by the same player in the same round fails (`init`).
    assert!(h
        .send(
            h.place_bet_ix(&player.pubkey(), round_id, SOL, 0),
            &[&player]
        )
        .is_err());

    let admin = h.admin.insecure_clone();
    h.send_ok(h.update_config_ix(1, false), &[&admin]);
    let other = h.player();
    h.expect_err(
        h.place_bet_ix(&other.pubkey(), round_id, SOL, 0),
        &[&other],
        CrashError::TooManyBets,
    );
    h.send_ok(h.update_config_ix(MAX_BETS, false), &[&admin]);

    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);
    h.expect_err(
        h.place_bet_ix(&other.pubkey(), round_id, SOL, 0),
        &[&other],
        CrashError::BettingClosed,
    );
}

#[test]
fn round_exposure_limit_is_enforced() {
    let mut h = Harness::new();
    h.deposit(5_000 * SOL);
    let round_id = h.open_round([1; 32]);
    // Each bet without auto reserves 100 SOL; the round allows 1 000 SOL.
    for _ in 0..10 {
        let player = h.player();
        h.bet(&player, round_id, SOL, 0);
    }
    let player = h.player();
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), round_id, SOL, 0),
        &[&player],
        CrashError::RoundExposureExceeded,
    );
}

#[test]
fn voided_round_refunds_exactly_and_closes_bets() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player();
    h.bet(&player, round_id, SOL / 2, 0);

    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.close_betting_ix(round_id),
        &[&operator],
        CrashError::BettingStillOpen,
    );
    h.close_betting(round_id);

    let stranger = h.player();
    h.expect_err(
        h.void_ix(&stranger.pubkey(), round_id),
        &[&stranger],
        CrashError::DeadlineNotReached,
    );
    // Once the entropy deadline passes, the reveal can no longer start the round: only void applies.
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.entropy_deadline_slot + 1);
    h.expect_err(
        h.start_round_ix(&stranger.pubkey(), round_id, VRF_OUTPUT),
        &[&stranger],
        CrashError::EntropyDeadlinePassed,
    );
    h.send_ok(h.void_ix(&stranger.pubkey(), round_id), &[&stranger]);
    assert_eq!(
        h.fetch::<Round>(&round_pda(round_id)).phase,
        RoundPhase::Voided
    );

    let before = h.lamports(&player.pubkey());
    h.send_ok(
        h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
        &[&stranger],
    );
    assert_eq!(h.lamports(&player.pubkey()) - before, SOL / 2);
    let bet: Bet = h.fetch(&bet_pda(round_id, &player.pubkey()));
    assert_eq!(bet.outcome, BetOutcome::Refunded);
    h.expect_err(
        h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
        &[&stranger],
        CrashError::BetAlreadySettled,
    );
    assert_eq!(h.fetch::<HouseVault>(&vault_pda()).reserved_exposure, 0);

    let rent = h.lamports(&bet_pda(round_id, &player.pubkey()));
    let before = h.lamports(&player.pubkey());
    h.send_ok(h.close_bet_ix(round_id, &player.pubkey()), &[&stranger]);
    assert_eq!(h.lamports(&player.pubkey()) - before, rent);
    assert!(h
        .svm
        .get_account(&bet_pda(round_id, &player.pubkey()))
        .is_none_or(|a| a.lamports == 0));

    // Only the operator may void while betting is open.
    let next = h.open_round([2; 32]);
    h.expect_err(
        h.void_ix(&stranger.pubkey(), next),
        &[&stranger],
        CrashError::OperatorRequired,
    );
    h.send_ok(h.void_ix(&operator.pubkey(), next), &[&operator]);
}

#[test]
fn revealed_round_settles_exactly_like_the_rules() {
    let mut h = Harness::new();
    h.deposit(1_000 * SOL);
    let (seed, crash_point) = seed_with_crash_between(0, 30_000, 1_000_000);
    let round_id = h.open_round(seed);
    let crash_tick = RULES.crash_tick(crash_point).unwrap();

    let early = h.player(); // manual cash-out at the first tick >= 2.00x
    let auto = h.player(); // auto at 2.50x
    let late = h.player(); // manual cash-out at the crash tick: loses
    let holder = h.player(); // never cashes out: loses
    for (player, auto_cash_out) in [(&early, 0), (&auto, 25_000), (&late, 0), (&holder, 0)] {
        h.bet(player, round_id, SOL, auto_cash_out);
    }
    h.close_betting(round_id);
    h.start_round(round_id);

    h.expect_err(
        h.cash_out_ix(&early.pubkey(), &early.pubkey(), round_id),
        &[&early],
        CrashError::CashOutTooEarly,
    );
    let two_x_tick = RULES.first_tick_at_least(20_000).unwrap();
    h.warp_to_tick(round_id, two_x_tick);
    h.send_ok(
        h.cash_out_ix(&early.pubkey(), &early.pubkey(), round_id),
        &[&early],
    );
    h.expect_err(
        h.cash_out_ix(&early.pubkey(), &early.pubkey(), round_id),
        &[&early],
        CrashError::AlreadyCashedOut,
    );
    // Nobody can cash out someone else's bet.
    assert!(h
        .send(
            h.cash_out_ix(&late.pubkey(), &holder.pubkey(), round_id),
            &[&late]
        )
        .is_err());

    // Revealing before the curve reaches the crash point is refused.
    h.expect_err(
        h.reveal_ix(round_id, seed),
        &[&late],
        CrashError::RevealTooEarly,
    );
    h.warp_to_tick(round_id, crash_tick);
    h.send_ok(
        h.cash_out_ix(&late.pubkey(), &late.pubkey(), round_id),
        &[&late],
    );
    h.expect_err(
        h.reveal_ix(round_id, [9; 32]),
        &[&late],
        CrashError::CommitmentMismatch,
    );
    h.send_ok(h.reveal_ix(round_id, seed), &[&late]);

    let round: Round = h.fetch(&round_pda(round_id));
    assert_eq!(
        (round.phase, round.crash_point, round.crash_tick),
        (RoundPhase::Crashed, crash_point, crash_tick)
    );
    assert_eq!(round.seed, seed);
    h.expect_err(
        h.cash_out_ix(&holder.pubkey(), &holder.pubkey(), round_id),
        &[&holder],
        CrashError::InvalidPhase,
    );

    // Payouts can only go to the bet's player.
    let stranger = h.player();
    assert!(h
        .send(
            h.settle_ix(round_id, &early.pubkey(), &stranger.pubkey()),
            &[&stranger]
        )
        .is_err());

    for player in [&early, &auto, &late, &holder] {
        let bet: Bet = h.fetch(&bet_pda(round_id, &player.pubkey()));
        let expected = crash_rules::settle_bet(
            &RULES,
            bet.stake,
            bet.auto_target(),
            bet.cash_out_tick,
            crash_point,
        )
        .unwrap();
        let before = h.lamports(&player.pubkey());
        h.send_ok(
            h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
            &[&stranger],
        );
        assert_eq!(h.lamports(&player.pubkey()) - before, expected.payout());
    }
    let paid =
        |h: &Harness, player: &Keypair| h.fetch::<Bet>(&bet_pda(round_id, &player.pubkey())).payout;
    // The curve jumps from 1.98x to 2.03x, so the first tick at or above 2.00x pays 2.03x.
    let early_multiplier = RULES.recognized_at_tick(two_x_tick).unwrap();
    assert_eq!(early_multiplier, 20_300);
    assert_eq!(paid(&h, &early), SOL * early_multiplier / 10_000);
    assert_eq!(paid(&h, &auto), 5 * SOL / 2);
    assert_eq!(paid(&h, &late), 0);
    assert_eq!(paid(&h, &holder), 0);
    assert_eq!(
        h.fetch::<Round>(&round_pda(round_id)).phase,
        RoundPhase::Settled
    );
    assert_eq!(h.fetch::<HouseVault>(&vault_pda()).reserved_exposure, 0);
    assert_eq!(h.fetch::<HouseConfig>(&config_pda()).current_round, None);
}

#[test]
fn unrevealed_round_is_forfeited_in_favor_of_players() {
    let mut h = Harness::new();
    h.deposit(1_000 * SOL);
    let (seed, _) = seed_with_crash_between(0, 10_000, 1_000_000);
    let round_id = h.open_round(seed);
    let cashed = h.player();
    let auto = h.player();
    let holder = h.player();
    h.bet(&cashed, round_id, SOL, 0);
    h.bet(&auto, round_id, SOL, 50_000);
    h.bet(&holder, round_id, SOL, 0);
    h.close_betting(round_id);
    h.start_round(round_id);
    h.warp_to_tick(round_id, RULES.first_tick_at_least(30_000).unwrap());
    h.send_ok(
        h.cash_out_ix(&cashed.pubkey(), &cashed.pubkey(), round_id),
        &[&cashed],
    );

    h.expect_err(
        h.forfeit_ix(round_id),
        &[&holder],
        CrashError::DeadlineNotReached,
    );
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.reveal_deadline_slot + 1);
    h.expect_err(
        h.reveal_ix(round_id, seed),
        &[&holder],
        CrashError::RevealDeadlinePassed,
    );
    h.send_ok(h.forfeit_ix(round_id), &[&holder]);

    let multiplier = RULES
        .recognized_at_tick(RULES.first_tick_at_least(30_000).unwrap())
        .unwrap();
    let crank = h.player();
    for (player, expected) in [
        (&cashed, SOL * multiplier / 10_000),
        (&auto, 5 * SOL),
        (&holder, SOL),
    ] {
        let before = h.lamports(&player.pubkey());
        h.send_ok(
            h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
            &[&crank],
        );
        assert_eq!(h.lamports(&player.pubkey()) - before, expected);
    }
}

#[test]
fn pause_never_blocks_exit_paths() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let (seed, crash_point) = seed_with_crash_between(0, 20_000, 1_000_000);
    let round_id = h.open_round(seed);
    let player = h.player();
    h.bet(&player, round_id, SOL, 0);
    h.close_betting(round_id);
    h.start_round(round_id);

    let admin = h.admin.insecure_clone();
    h.send_ok(h.update_config_ix(MAX_BETS, true), &[&admin]);
    h.warp_to_tick(round_id, RULES.first_tick_at_least(15_000).unwrap());
    h.send_ok(
        h.cash_out_ix(&player.pubkey(), &player.pubkey(), round_id),
        &[&player],
    );
    h.warp_to_tick(round_id, RULES.crash_tick(crash_point).unwrap());
    h.send_ok(h.reveal_ix(round_id, seed), &[&player]);
    h.send_ok(
        h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
        &[&player],
    );
    assert_eq!(
        h.fetch::<Bet>(&bet_pda(round_id, &player.pubkey())).outcome,
        BetOutcome::CashedOut
    );
}

#[test]
fn randomness_account_is_controlled_by_the_program_pda() {
    let mut h = Harness::without_randomness();
    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 0, [1; 32]),
        &[&operator],
        CrashError::RandomnessNotConfigured,
    );

    let stranger = h.player();
    let account = Keypair::new();
    assert!(h
        .send(
            h.create_randomness_ix(&stranger.pubkey(), &account.pubkey()),
            &[&stranger, &account]
        )
        .is_err());
    let admin = h.admin.insecure_clone();
    h.expect_err(
        h.create_randomness_ix_with(&admin.pubkey(), &account.pubkey(), &Pubkey::new_unique()),
        &[&admin, &account],
        CrashError::InvalidRandomnessAccount,
    );

    h.send_ok(
        h.create_randomness_ix(&admin.pubkey(), &account.pubkey()),
        &[&admin, &account],
    );
    h.randomness = account.pubkey();
    let config: HouseConfig = h.fetch(&config_pda());
    assert_eq!(config.randomness_account, account.pubkey());
    let state = h.randomness_state();
    assert_eq!(state.authority, randomness_authority_pda());
    assert_eq!(state.queue, QUEUE);

    // No rotation while a round is active.
    h.open_round([1; 32]);
    let rotated = Keypair::new();
    h.expect_err(
        h.create_randomness_ix(&admin.pubkey(), &rotated.pubkey()),
        &[&admin, &rotated],
        CrashError::RoundStillActive,
    );
}

#[test]
fn round_starts_only_with_its_own_fresh_randomness() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player();
    h.bet(&player, round_id, SOL, 0);
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);

    let stranger = h.player();
    // Starting requires the commit first: until then the round is bound to no randomness account.
    h.expect_err(
        h.start_round_ix(&stranger.pubkey(), round_id, VRF_OUTPUT),
        &[&stranger],
        CrashError::InvalidRandomnessAccount,
    );
    // Only the house account and the pinned Switchboard program are accepted.
    h.expect_err(
        h.close_betting_ix_with(round_id, &Pubkey::new_unique(), &switchboard::PROGRAM_ID),
        &[&stranger],
        CrashError::InvalidRandomnessAccount,
    );
    h.expect_err(
        h.close_betting_ix_with(round_id, &h.randomness, &Pubkey::new_unique()),
        &[&stranger],
        CrashError::InvalidRandomnessAccount,
    );

    // Anyone may close betting; the commit binds the round to the account and seed slot.
    let close_slot = h.slot();
    h.send_ok(h.close_betting_ix(round_id), &[&stranger]);
    let round: Round = h.fetch(&round_pda(round_id));
    assert_eq!(round.phase, RoundPhase::AwaitingEntropy);
    assert_eq!(round.randomness_account, h.randomness);
    assert_eq!(round.randomness_seed_slot, close_slot - 1);
    assert_eq!(h.randomness_state().seed_slot, close_slot - 1);

    h.warp(close_slot + 2);
    h.expect_err(
        h.start_round_ix_with(
            &stranger.pubkey(),
            round_id,
            VRF_OUTPUT,
            0,
            &Pubkey::new_unique(),
        ),
        &[&stranger],
        CrashError::InvalidRandomnessAccount,
    );
    // A reveal that leaves the account without a value for this slot is rejected.
    h.expect_err(
        h.start_round_ix_with(
            &stranger.pubkey(),
            round_id,
            VRF_OUTPUT,
            switchboard_mock::NO_OP_RECOVERY_ID,
            &switchboard::PROGRAM_ID,
        ),
        &[&stranger],
        CrashError::StaleRandomness,
    );
    // A value committed to another seed slot is rejected.
    let foreign_seed_slot = close_slot - 5;
    h.patch_randomness(
        switchboard::SEED_SLOT_OFFSET,
        &foreign_seed_slot.to_le_bytes(),
    );
    h.expect_err(
        h.start_round_ix(&stranger.pubkey(), round_id, VRF_OUTPUT),
        &[&stranger],
        CrashError::StaleRandomness,
    );
    h.patch_randomness(
        switchboard::SEED_SLOT_OFFSET,
        &(close_slot - 1).to_le_bytes(),
    );

    // Anyone can start the round with the public reveal payload.
    let start_slot = h.slot();
    h.send_ok(
        h.start_round_ix(&stranger.pubkey(), round_id, VRF_OUTPUT),
        &[&stranger],
    );
    let round: Round = h.fetch(&round_pda(round_id));
    assert_eq!(round.phase, RoundPhase::Running);
    assert_eq!(round.vrf_output, VRF_OUTPUT);
    assert_eq!(round.start_slot, start_slot);
    assert_eq!(
        round.reveal_deadline_slot,
        start_slot + RULES.horizon().unwrap() + TIMEOUTS.reveal_grace_slots
    );
    h.warp(start_slot + 1);
    h.expect_err(
        h.start_round_ix(&stranger.pubkey(), round_id, [9; 32]),
        &[&stranger],
        CrashError::InvalidPhase,
    );
}

#[test]
fn stuck_betting_round_can_be_voided_by_anyone_after_the_timeout() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player();
    h.bet(&player, round_id, SOL, 0);

    let round: Round = h.fetch(&round_pda(round_id));
    let stuck_after = round.betting_end_slot + TIMEOUTS.entropy_timeout_slots;
    let stranger = h.player();
    h.warp(stuck_after);
    h.expect_err(
        h.void_ix(&stranger.pubkey(), round_id),
        &[&stranger],
        CrashError::OperatorRequired,
    );
    h.warp(stuck_after + 1);
    h.send_ok(h.void_ix(&stranger.pubkey(), round_id), &[&stranger]);
    assert_eq!(
        h.fetch::<Round>(&round_pda(round_id)).phase,
        RoundPhase::Voided
    );
    let before = h.lamports(&player.pubkey());
    h.send_ok(
        h.settle_ix(round_id, &player.pubkey(), &player.pubkey()),
        &[&stranger],
    );
    assert_eq!(h.lamports(&player.pubkey()) - before, SOL);
}

/// Real Switchboard costs measured on devnet (docs/spikes/vrf-devnet.md).
const DEVNET_COMMIT_CU: u64 = 15_109;
const DEVNET_REVEAL_CU: u64 = 41_934;
const DEFAULT_CU_LIMIT: u64 = 200_000;

#[test]
fn randomness_instructions_fit_the_default_compute_budget() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let round_id = h.open_round([1; 32]);
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);
    let operator = h.operator.insecure_clone();
    let close = h.send_ok(h.close_betting_ix(round_id), &[&operator]);
    h.warp(h.slot() + 2);
    let start = h.send_ok(
        h.start_round_ix(&operator.pubkey(), round_id, VRF_OUTPUT),
        &[&operator],
    );
    println!("compute units with the mock: close_betting {close}, start_round {start}");
    // The mock's own cost is included, so adding the real Switchboard cost is an upper bound.
    assert!(close + DEVNET_COMMIT_CU < DEFAULT_CU_LIMIT);
    assert!(start + DEVNET_REVEAL_CU < DEFAULT_CU_LIMIT);
}
