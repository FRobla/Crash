//! LiteSVM tests of the Crash program (docs/specs/crash-program-v2.md §7–§12).
//!
//! Switchboard is replaced by the test-only mock in `test-programs/switchboard-mock`, loaded at the
//! devnet program id. It runs the same commit/reveal account checks but lets the test choose the
//! revealed value; the oracle signature is only verified by the real program on devnet.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    crash::{
        error::CrashError, randomness, switchboard, HouseConfig, HouseVault, Limits, Player,
        PlayerPolicy, Round, RoundPhase, Timeouts, UsernameRecord,
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
/// 1 coin = 10⁶ lamports (1 SOL = 1000 coins).
const COIN: u64 = 1_000_000;
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
const POLICY: PlayerPolicy = PlayerPolicy {
    max_session_slots: 1_512_000,
    username_cooldown_slots: 1_512_000,
};
const MAX_BETS: u32 = 256;
const RULES: crash_rules::Rules = crash_rules::CRASH_RULES_V1;
const VRF_OUTPUT: [u8; 32] = [7; 32];
const FEE_BUDGET: u64 = SOL / 100;

/// Stand-ins for Switchboard's queue and oracle; the mock only compares them with what it stored.
const QUEUE: Pubkey = Pubkey::new_from_array([0xA1; 32]);
const ORACLE: Pubkey = Pubkey::new_from_array([0xA2; 32]);

struct Harness {
    svm: LiteSVM,
    admin: Keypair,
    operator: Keypair,
    randomness: Pubkey,
    /// Owners whose `Player` accounts are checked after every transaction.
    owners: Vec<Pubkey>,
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

fn player_pda(owner: &Pubkey) -> Pubkey {
    pda(&[crash::PLAYER_SEED, owner.as_ref()])
}

fn username_pda(name: &str) -> Pubkey {
    pda(&[crash::USERNAME_SEED, name.as_bytes()])
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

/// Anchor's `AccountNotInitialized`: a PDA derived from the wrong owner or name does not exist.
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
/// Anchor's `ConstraintSeeds`.
const CONSTRAINT_SEEDS: u32 = 2006;
/// Anchor's `ConstraintHasOne`.
const CONSTRAINT_HAS_ONE: u32 = 2001;
/// System program `AccountAlreadyInUse`: `init` of a taken PDA.
const ACCOUNT_ALREADY_IN_USE: u32 = 0;

fn name_string(player: &Player) -> String {
    String::from_utf8(player.username.as_bytes().to_vec()).unwrap()
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
            owners: Vec::new(),
        };
        harness.send_ok(
            harness.initialize_ix(&harness.admin.pubkey()),
            &[&harness.admin.insecure_clone()],
        );
        harness
    }

    /// A funded wallet without a `Player` account.
    fn wallet(&mut self) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 100 * SOL).unwrap();
        self.owners.push(wallet.pubkey());
        wallet
    }

    /// A registered player with `coins` lamports of balance.
    fn player(&mut self, name: &str, coins: u64) -> Keypair {
        let owner = self.wallet();
        let mut ixs = vec![self.register_ix(&owner.pubkey(), name)];
        if coins > 0 {
            ixs.push(self.buy_ix(&owner.pubkey(), coins));
        }
        self.send_many_ok(&ixs, &[&owner]);
        owner
    }

    /// Compute units consumed on success, the custom error code on failure.
    /// `signers[0]` pays the fees.
    fn send_many(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, u32> {
        let payer = signers[0].pubkey();
        let message = Message::new_with_blockhash(ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => {
                self.assert_invariants();
                Ok(meta.compute_units_consumed)
            }
            Err(failure) => match failure.err {
                TransactionError::InstructionError(_, InstructionError::Custom(code)) => Err(code),
                other => panic!("unexpected failure {other:?}\n{:#?}", failure.meta.logs),
            },
        }
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<u64, u32> {
        self.send_many(&[ix], signers)
    }

    fn send_many_ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> u64 {
        self.send_many(ixs, signers)
            .unwrap_or_else(|code| panic!("transaction failed with custom error {code}"))
    }

    fn send_ok(&mut self, ix: Instruction, signers: &[&Keypair]) -> u64 {
        self.send_many_ok(&[ix], signers)
    }

    fn expect_code(&mut self, ix: Instruction, signers: &[&Keypair], code: u32) {
        assert_eq!(self.send(ix, signers), Err(code));
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

    fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .is_some_and(|account| account.lamports > 0)
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm
            .get_account(address)
            .map_or(0, |account| account.lamports)
    }

    fn player_state(&self, owner: &Keypair) -> Player {
        self.fetch(&player_pda(&owner.pubkey()))
    }

    fn balance(&self, owner: &Keypair) -> u64 {
        self.player_state(owner).balance
    }

    fn free_lamports(&self, address: &Pubkey) -> u64 {
        let account = self.svm.get_account(address).unwrap();
        account.lamports
            - self
                .svm
                .minimum_balance_for_rent_exemption(account.data.len())
    }

    /// Invariants 1, 11 and 16, checked after every successful transaction.
    fn assert_invariants(&self) {
        if self.exists(&vault_pda()) {
            let vault: HouseVault = self.fetch(&vault_pda());
            let free = self.free_lamports(&vault_pda());
            assert!(
                free >= vault.reserved_exposure,
                "vault insolvent: {free} < {}",
                vault.reserved_exposure
            );
        }
        for owner in &self.owners {
            let address = player_pda(owner);
            if !self.exists(&address) {
                continue;
            }
            let player: Player = self.fetch(&address);
            assert!(
                self.free_lamports(&address) >= player.balance,
                "player {owner} underfunded"
            );
            if !player.username.is_empty() {
                let record: UsernameRecord = self.fetch(&username_pda(&name_string(&player)));
                assert_eq!(record.owner, *owner, "username record of {owner}");
            }
        }
    }

    fn slot(&self) -> u64 {
        self.svm
            .get_sysvar::<anchor_lang::solana_program::clock::Clock>()
            .slot
    }

    fn warp(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
    }

    // ---- house and round instruction builders ----

    fn initialize_ix(&self, admin: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::InitializeHouse {
                operator: self.operator.pubkey(),
                limits: LIMITS,
                timeouts: TIMEOUTS,
                max_bets_per_round: MAX_BETS,
                player_policy: POLICY,
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
                player_policy: POLICY,
            }
            .data(),
            crash::accounts::UpdateConfig {
                admin: self.admin.pubkey(),
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    fn set_paused(&mut self, paused: bool) {
        let admin = self.admin.insecure_clone();
        self.send_ok(self.update_config_ix(MAX_BETS, paused), &[&admin]);
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

    // ---- bet instruction builders ----

    /// `signer` is the owner or a session key acting for `owner`'s `Player`.
    fn place_bet_ix(
        &self,
        signer: &Pubkey,
        owner: &Pubkey,
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
                signer: *signer,
                config: config_pda(),
                vault: vault_pda(),
                round: round_pda(round_id),
                player: player_pda(owner),
            }
            .to_account_metas(None),
        )
    }

    fn cash_out_ix(&self, signer: &Pubkey, owner: &Pubkey, round_id: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CashOut {}.data(),
            crash::accounts::CashOut {
                signer: *signer,
                round: round_pda(round_id),
                player: player_pda(owner),
            }
            .to_account_metas(None),
        )
    }

    fn settle_ix(&self, round_id: u64, owner: &Pubkey) -> Instruction {
        self.settle_ix_for(round_id, player_pda(owner))
    }

    fn settle_ix_for(&self, round_id: u64, player: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::SettleBet {}.data(),
            crash::accounts::SettleBet {
                round: round_pda(round_id),
                vault: vault_pda(),
                player,
            }
            .to_account_metas(None),
        )
    }

    // ---- player instruction builders ----

    fn register_ix(&self, owner: &Pubkey, name: &str) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::RegisterPlayer {
                username: name.to_string(),
            }
            .data(),
            crash::accounts::RegisterPlayer {
                owner: *owner,
                config: config_pda(),
                player: player_pda(owner),
                username_record: username_pda(name),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn buy_ix(&self, owner: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::BuyCoins { amount }.data(),
            crash::accounts::BuyCoins {
                owner: *owner,
                config: config_pda(),
                player: player_pda(owner),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn sell_ix(&self, owner: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::SellCoins { amount }.data(),
            crash::accounts::SellCoins {
                owner: *owner,
                player: player_pda(owner),
            }
            .to_account_metas(None),
        )
    }

    fn create_session_ix(
        &self,
        owner: &Pubkey,
        key: &Pubkey,
        expires_slot: u64,
        spend_cap: u64,
        fee_budget: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::CreateSession {
                expires_slot,
                spend_cap,
                fee_budget,
            }
            .data(),
            crash::accounts::CreateSession {
                owner: *owner,
                config: config_pda(),
                player: player_pda(owner),
                session_key: *key,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn revoke_ix(&self, signer: &Pubkey, owner: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::RevokeSession {}.data(),
            crash::accounts::RevokeSession {
                signer: *signer,
                player: player_pda(owner),
            }
            .to_account_metas(None),
        )
    }

    fn change_username_ix(&self, owner: &Pubkey, new: &str, old: Option<&str>) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::ChangeUsername {
                username: new.to_string(),
            }
            .data(),
            crash::accounts::ChangeUsername {
                owner: *owner,
                config: config_pda(),
                player: player_pda(owner),
                new_record: username_pda(new),
                old_record: old.map(username_pda),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn reset_username_ix(&self, admin: &Pubkey, owner: &Pubkey, name: &str) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::ResetUsername {}.data(),
            crash::accounts::ResetUsername {
                admin: *admin,
                config: config_pda(),
                player: player_pda(owner),
                username_record: username_pda(name),
                owner: *owner,
            }
            .to_account_metas(None),
        )
    }

    fn close_player_ix(&self, owner: &Pubkey, name: Option<&str>) -> Instruction {
        Instruction::new_with_bytes(
            crash::ID,
            &crash::instruction::ClosePlayer {}.data(),
            crash::accounts::ClosePlayer {
                owner: *owner,
                player: player_pda(owner),
                username_record: name.map(username_pda),
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

    fn bet(&mut self, owner: &Keypair, round_id: u64, stake: u64, auto_cash_out: u64) {
        self.send_ok(
            self.place_bet_ix(
                &owner.pubkey(),
                &owner.pubkey(),
                round_id,
                stake,
                auto_cash_out,
            ),
            &[owner],
        );
    }

    fn cash_out(&mut self, owner: &Keypair, round_id: u64) {
        self.send_ok(
            self.cash_out_ix(&owner.pubkey(), &owner.pubkey(), round_id),
            &[owner],
        );
    }

    fn settle(&mut self, round_id: u64, owner: &Keypair) {
        let crank = self.operator.insecure_clone();
        self.send_ok(self.settle_ix(round_id, &owner.pubkey()), &[&crank]);
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

    /// Operator void while betting is open: the quickest way to finish a round in tests.
    fn void_open_round(&mut self, round_id: u64) {
        let operator = self.operator.insecure_clone();
        self.send_ok(self.void_ix(&operator.pubkey(), round_id), &[&operator]);
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

// ---- house ----

#[test]
fn initialize_is_reserved_to_the_upgrade_authority() {
    let mut svm_harness = Harness::new();
    let config: HouseConfig = svm_harness.fetch(&config_pda());
    assert_eq!(config.admin, svm_harness.admin.pubkey());
    assert_eq!(config.operator, svm_harness.operator.pubkey());
    assert_eq!(config.rules_version, 1);
    assert_eq!(config.current_round, None);
    assert_eq!(config.player_policy, POLICY);

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
fn withdrawals_never_touch_reserved_exposure_or_player_funds() {
    let mut h = Harness::new();
    h.deposit(200 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player("whale", 5 * SOL);
    h.bet(&player, round_id, SOL, 0); // exposure: 1 SOL · 100x = 100 SOL

    let admin = h.admin.insecure_clone();
    let vault: HouseVault = h.fetch(&vault_pda());
    assert_eq!(vault.reserved_exposure, 100 * SOL);
    // Free vault lamports = 200 (bank) + 1 (stake) = 201 SOL; available = 201 - 100 reserved.
    // The player's remaining 4 SOL live in its own PDA and are not part of the vault.
    h.expect_err(
        h.withdraw_ix(&admin.pubkey(), 101 * SOL + 1),
        &[&admin],
        CrashError::WithdrawalExceedsAvailable,
    );
    h.send_ok(h.withdraw_ix(&admin.pubkey(), 101 * SOL), &[&admin]);
    assert_eq!(h.balance(&player), 4 * SOL);

    let stranger = h.wallet();
    assert!(h
        .send(h.withdraw_ix(&stranger.pubkey(), 1), &[&stranger])
        .is_err());
}

#[test]
fn open_round_guards() {
    let mut h = Harness::new();
    let stranger = h.wallet();
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

    h.set_paused(true);
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 0, [1; 32]),
        &[&operator],
        CrashError::Paused,
    );
    h.set_paused(false);

    let round_id = h.open_round([1; 32]);
    assert_eq!(round_id, 0);
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 1, [2; 32]),
        &[&operator],
        CrashError::RoundStillActive,
    );
}

// ---- players, coins and sessions ----

#[test]
fn onboarding_session_play_and_exit() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let (seed, crash_point) = seed_with_crash_between(0, 30_000, 1_000_000);
    let owner = h.wallet();
    let session = Keypair::new();
    let admin = h.admin.insecure_clone();

    // Registration, purchase and session in one transaction with a single wallet signature.
    let expires = h.slot() + 216_000;
    let wallet_before = h.lamports(&owner.pubkey());
    h.send_many_ok(
        &[
            h.register_ix(&owner.pubkey(), "alice"),
            h.buy_ix(&owner.pubkey(), SOL),
            h.create_session_ix(&owner.pubkey(), &session.pubkey(), expires, SOL, FEE_BUDGET),
        ],
        &[&admin, &owner],
    );
    let player_rent = h.lamports(&player_pda(&owner.pubkey())) - SOL;
    let record_rent = h.lamports(&username_pda("alice"));
    assert_eq!(
        wallet_before - h.lamports(&owner.pubkey()),
        player_rent + record_rent + SOL + FEE_BUDGET
    );
    assert_eq!(h.lamports(&session.pubkey()), FEE_BUDGET);
    let state = h.player_state(&owner);
    assert_eq!(state.balance, SOL);
    assert_eq!(name_string(&state), "alice");
    assert_eq!(state.session.unwrap().key, session.pubkey());
    assert_eq!(
        h.fetch::<UsernameRecord>(&username_pda("alice")).owner,
        owner.pubkey()
    );
    assert_eq!(SOL, 1000 * COIN); // 1 SOL buys 1000 coins

    // The session key signs and pays for the bet and the cash-out; the wallet signs nothing.
    let round_id = h.open_round(seed);
    let vault_before = h.lamports(&vault_pda());
    h.send_ok(
        h.place_bet_ix(&session.pubkey(), &owner.pubkey(), round_id, SOL / 2, 0),
        &[&session],
    );
    assert_eq!(h.balance(&owner), SOL / 2);
    assert_eq!(h.lamports(&vault_pda()) - vault_before, SOL / 2);
    let state = h.player_state(&owner);
    assert_eq!(state.session.unwrap().spent, SOL / 2);
    assert_eq!(state.active_bet.unwrap().stake, SOL / 2);

    h.close_betting(round_id);
    h.start_round(round_id);
    let tick = RULES.first_tick_at_least(20_000).unwrap();
    h.warp_to_tick(round_id, tick);
    h.send_ok(
        h.cash_out_ix(&session.pubkey(), &owner.pubkey(), round_id),
        &[&session],
    );
    h.warp_to_tick(round_id, RULES.crash_tick(crash_point).unwrap());
    h.send_ok(h.reveal_ix(round_id, seed), &[&admin]);
    h.settle(round_id, &owner);

    let payout = SOL / 2 * RULES.recognized_at_tick(tick).unwrap() / 10_000;
    let state = h.player_state(&owner);
    assert_eq!(state.balance, SOL / 2 + payout);
    assert_eq!(state.active_bet, None);
    assert_eq!((state.total_wagered, state.bets_settled), (SOL / 2, 1));

    // Exit: revoke, sell everything, sweep the session key and close; the wallet gets it all back.
    let balance = state.balance;
    let wallet_before = h.lamports(&owner.pubkey());
    let player_lamports = h.lamports(&player_pda(&owner.pubkey()));
    h.send_many_ok(
        &[
            h.revoke_ix(&owner.pubkey(), &owner.pubkey()),
            h.sell_ix(&owner.pubkey(), balance),
            system_instruction::transfer(&session.pubkey(), &owner.pubkey(), FEE_BUDGET - 10_000),
            h.close_player_ix(&owner.pubkey(), Some("alice")),
        ],
        &[&admin, &owner, &session],
    );
    assert_eq!(
        h.lamports(&owner.pubkey()) - wallet_before,
        player_lamports + record_rent + FEE_BUDGET - 10_000
    );
    assert!(!h.exists(&player_pda(&owner.pubkey())));
    assert!(!h.exists(&username_pda("alice")));
}

#[test]
fn coins_are_bought_and_sold_one_to_one() {
    let mut h = Harness::new();
    let owner = h.player("bob", 0);
    let admin = h.admin.insecure_clone();
    h.expect_err(
        h.buy_ix(&owner.pubkey(), 0),
        &[&owner],
        CrashError::ZeroAmount,
    );
    h.send_ok(h.buy_ix(&owner.pubkey(), 3 * COIN + 1), &[&owner]);
    assert_eq!(h.balance(&owner), 3 * COIN + 1);

    h.expect_err(
        h.sell_ix(&owner.pubkey(), 3 * COIN + 2),
        &[&owner],
        CrashError::InsufficientBalance,
    );
    let before = h.lamports(&owner.pubkey());
    h.send_many_ok(&[h.sell_ix(&owner.pubkey(), COIN)], &[&admin, &owner]);
    assert_eq!(h.lamports(&owner.pubkey()) - before, COIN);
    assert_eq!(h.balance(&owner), 2 * COIN + 1);

    // Donations to the PDA are not balance, and still reach the owner when the account closes.
    let donor = h.wallet();
    h.send_ok(
        system_instruction::transfer(&donor.pubkey(), &player_pda(&owner.pubkey()), SOL),
        &[&donor],
    );
    assert_eq!(h.balance(&owner), 2 * COIN + 1);
    h.expect_err(
        h.close_player_ix(&owner.pubkey(), Some("bob")),
        &[&owner],
        CrashError::PlayerNotEmpty,
    );
    h.send_ok(h.sell_ix(&owner.pubkey(), 2 * COIN + 1), &[&owner]);
    let player_lamports = h.lamports(&player_pda(&owner.pubkey()));
    let record_rent = h.lamports(&username_pda("bob"));
    let before = h.lamports(&owner.pubkey());
    h.send_many_ok(
        &[h.close_player_ix(&owner.pubkey(), Some("bob"))],
        &[&admin, &owner],
    );
    assert_eq!(
        h.lamports(&owner.pubkey()) - before,
        player_lamports + record_rent
    );
    assert!(player_lamports > SOL);

    // Another wallet cannot sell from a player that is not its own.
    let victim = h.player("carol", SOL);
    let thief = h.player("mallory", 0);
    let ix = h.sell_ix(&thief.pubkey(), SOL);
    let mut forged = ix.clone();
    forged.accounts[1].pubkey = player_pda(&victim.pubkey());
    assert!(h.send(forged, &[&thief]).is_err());
    assert_eq!(h.balance(&victim), SOL);
}

#[test]
fn session_limits_are_exact() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let owner = h.player("dave", 10 * SOL);
    let session = Keypair::new();
    h.svm.airdrop(&session.pubkey(), SOL).unwrap();
    let stake = SOL / 10;
    let start = h.slot();

    // Invalid parameters.
    for (key, expires, cap) in [
        (owner.pubkey(), start + 10, stake),
        (session.pubkey(), start, stake),
        (
            session.pubkey(),
            start + POLICY.max_session_slots + 1,
            stake,
        ),
        (session.pubkey(), start + 10, 0),
    ] {
        h.expect_err(
            h.create_session_ix(&owner.pubkey(), &key, expires, cap, 0),
            &[&owner],
            CrashError::InvalidSession,
        );
    }
    h.expect_err(
        h.revoke_ix(&owner.pubkey(), &owner.pubkey()),
        &[&owner],
        CrashError::NoSession,
    );

    // Spend cap: two bets fill it exactly; one more lamport is refused.
    let expires = start + 1_000;
    h.send_ok(
        h.create_session_ix(&owner.pubkey(), &session.pubkey(), expires, 2 * stake, 0),
        &[&owner],
    );
    for _ in 0..2 {
        let round_id = h.open_round([1; 32]);
        h.send_ok(
            h.place_bet_ix(&session.pubkey(), &owner.pubkey(), round_id, stake, 0),
            &[&session],
        );
        h.void_open_round(round_id);
        h.settle(round_id, &owner);
    }
    let round_id = h.open_round([1; 32]);
    h.expect_err(
        h.place_bet_ix(
            &session.pubkey(),
            &owner.pubkey(),
            round_id,
            LIMITS.min_stake,
            0,
        ),
        &[&session],
        CrashError::SessionSpendCapExceeded,
    );
    // The owner is not bound by the session cap.
    h.bet(&owner, round_id, stake, 0);
    h.void_open_round(round_id);
    h.settle(round_id, &owner);

    // Expiry: a bet at `expires_slot` is accepted.
    let expires = h.slot() + 10;
    h.send_ok(
        h.create_session_ix(&owner.pubkey(), &session.pubkey(), expires, 10 * stake, 0),
        &[&owner],
    );
    let (seed, crash_point) = seed_with_crash_between(3, 30_000, 1_000_000);
    let round_id = h.open_round(seed);
    assert_eq!(round_id, 3);
    let round: Round = h.fetch(&round_pda(round_id));
    assert!(round.betting_end_slot > expires);
    h.warp(expires);
    h.send_ok(
        h.place_bet_ix(&session.pubkey(), &owner.pubkey(), round_id, stake, 0),
        &[&session],
    );
    // An expired session can still cash out: it commits no funds.
    h.close_betting(round_id);
    h.start_round(round_id);
    assert!(h.slot() > expires);
    h.warp_to_tick(round_id, RULES.first_tick_at_least(15_000).unwrap());
    h.send_ok(
        h.cash_out_ix(&session.pubkey(), &owner.pubkey(), round_id),
        &[&session],
    );
    h.warp_to_tick(round_id, RULES.crash_tick(crash_point).unwrap());
    let operator = h.operator.insecure_clone();
    h.send_ok(h.reveal_ix(round_id, seed), &[&operator]);
    h.settle(round_id, &owner);
    assert_eq!(
        h.player_state(&owner).bets_settled,
        1,
        "only the revealed round earns experience"
    );

    // A new session replaces the old one: the old key stops working.
    let replacement = Keypair::new();
    h.svm.airdrop(&replacement.pubkey(), SOL).unwrap();
    let expires = h.slot() + 10;
    h.send_ok(
        h.create_session_ix(&owner.pubkey(), &replacement.pubkey(), expires, SOL, 0),
        &[&owner],
    );
    let round_id = h.open_round([1; 32]);
    h.expect_err(
        h.place_bet_ix(&session.pubkey(), &owner.pubkey(), round_id, stake, 0),
        &[&session],
        CrashError::Unauthorized,
    );
    h.expect_err(
        h.revoke_ix(&session.pubkey(), &owner.pubkey()),
        &[&session],
        CrashError::Unauthorized,
    );
    // One slot after `expires_slot` the session can no longer bet, still inside the betting window.
    h.warp(expires + 1);
    assert!(h.fetch::<Round>(&round_pda(round_id)).betting_end_slot > expires + 1);
    h.expect_err(
        h.place_bet_ix(&replacement.pubkey(), &owner.pubkey(), round_id, stake, 0),
        &[&replacement],
        CrashError::SessionExpired,
    );
    // The session key can revoke itself, even after expiry.
    h.send_ok(
        h.revoke_ix(&replacement.pubkey(), &owner.pubkey()),
        &[&replacement],
    );
    assert_eq!(h.player_state(&owner).session, None);
    h.expect_err(
        h.place_bet_ix(&replacement.pubkey(), &owner.pubkey(), round_id, stake, 0),
        &[&replacement],
        CrashError::Unauthorized,
    );
}

#[test]
fn a_session_key_can_only_bet_cash_out_and_revoke() {
    let mut h = Harness::new();
    let owner = h.player("erin", SOL);
    let session = Keypair::new();
    h.svm.airdrop(&session.pubkey(), SOL).unwrap();
    h.send_ok(
        h.create_session_ix(&owner.pubkey(), &session.pubkey(), h.slot() + 100, SOL, 0),
        &[&owner],
    );

    // Owner-only instructions derive the `Player` from the signer and check `has_one = owner`.
    let with_player = |mut ix: Instruction, index: usize| {
        ix.accounts[index].pubkey = player_pda(&owner.pubkey());
        ix
    };
    let attempts = [
        with_player(h.sell_ix(&session.pubkey(), 1), 1),
        with_player(h.close_player_ix(&session.pubkey(), Some("erin")), 1),
        with_player(
            h.create_session_ix(
                &session.pubkey(),
                &Keypair::new().pubkey(),
                h.slot() + 10,
                1,
                0,
            ),
            2,
        ),
        with_player(
            h.change_username_ix(&session.pubkey(), "erin2", Some("erin")),
            2,
        ),
        with_player(h.buy_ix(&session.pubkey(), 1), 2),
    ];
    for ix in attempts {
        let result = h.send(ix, &[&session]);
        assert!(
            result == Err(CONSTRAINT_SEEDS) || result == Err(CONSTRAINT_HAS_ONE),
            "{result:?}"
        );
    }
    assert_eq!(h.balance(&owner), SOL);
    assert_eq!(name_string(&h.player_state(&owner)), "erin");

    // A stranger cannot use someone else's player at all.
    let stranger = h.wallet();
    h.expect_err(
        h.revoke_ix(&stranger.pubkey(), &owner.pubkey()),
        &[&stranger],
        CrashError::Unauthorized,
    );
}

#[test]
fn usernames_are_canonical_unique_and_moderated() {
    let mut h = Harness::new();
    let wallet = h.wallet();
    for bad in [
        "ab",
        "Alice",
        "al-ice",
        "al ice",
        "abcdefghijklmnopq",
        "ñandu",
    ] {
        let result = h.send(h.register_ix(&wallet.pubkey(), bad), &[&wallet]);
        assert_eq!(result, Err(custom(CrashError::InvalidUsername)), "{bad}");
    }
    for good in ["abc", "abcdefghijklmnop", "a_1"] {
        let owner = h.player(good, 0);
        assert_eq!(name_string(&h.player_state(&owner)), good);
    }
    // Taken name: `init` of the record fails.
    h.expect_code(
        h.register_ix(&wallet.pubkey(), "abc"),
        &[&wallet],
        ACCOUNT_ALREADY_IN_USE,
    );

    // Cooldown: exact to the slot; the old name is freed for others.
    let owner = h.player("frank", 0);
    let registered = h.player_state(&owner).username_changed_slot;
    h.warp(registered + POLICY.username_cooldown_slots - 1);
    h.expect_err(
        h.change_username_ix(&owner.pubkey(), "franky", Some("frank")),
        &[&owner],
        CrashError::UsernameCooldown,
    );
    h.expect_err(
        h.change_username_ix(&owner.pubkey(), "franky", None),
        &[&owner],
        CrashError::UsernameRecordMismatch,
    );
    h.warp(registered + POLICY.username_cooldown_slots);
    h.send_ok(
        h.change_username_ix(&owner.pubkey(), "franky", Some("frank")),
        &[&owner],
    );
    assert_eq!(name_string(&h.player_state(&owner)), "franky");
    assert!(!h.exists(&username_pda("frank")));
    let other = h.player("frank", 0);
    assert_eq!(
        h.fetch::<UsernameRecord>(&username_pda("frank")).owner,
        other.pubkey()
    );
    // Someone else's record cannot stand in for the player's current name.
    h.warp(h.slot() + POLICY.username_cooldown_slots);
    let result = h.send(
        h.change_username_ix(&owner.pubkey(), "fred", Some("frank")),
        &[&owner],
    );
    assert!(result.is_err());

    // Reset: admin only; frees the name, restarts the cooldown and touches nothing else.
    h.send_ok(h.buy_ix(&owner.pubkey(), SOL), &[&owner]);
    let stranger = h.wallet();
    assert!(h
        .send(
            h.reset_username_ix(&stranger.pubkey(), &owner.pubkey(), "franky"),
            &[&stranger]
        )
        .is_err());
    let admin = h.admin.insecure_clone();
    let record_rent = h.lamports(&username_pda("franky"));
    let before = h.lamports(&owner.pubkey());
    h.send_ok(
        h.reset_username_ix(&admin.pubkey(), &owner.pubkey(), "franky"),
        &[&admin],
    );
    assert_eq!(h.lamports(&owner.pubkey()) - before, record_rent);
    let state = h.player_state(&owner);
    assert!(state.username.is_empty());
    assert_eq!(state.balance, SOL);
    assert_eq!(state.username_changed_slot, h.slot());
    h.expect_err(
        h.change_username_ix(&owner.pubkey(), "frankie", None),
        &[&owner],
        CrashError::UsernameCooldown,
    );
    h.warp(h.slot() + POLICY.username_cooldown_slots);
    h.send_ok(
        h.change_username_ix(&owner.pubkey(), "frankie", None),
        &[&owner],
    );

    // A nameless player closes without a record.
    let nameless = h.player("zed", 0);
    h.send_ok(
        h.reset_username_ix(&admin.pubkey(), &nameless.pubkey(), "zed"),
        &[&admin],
    );
    // The freed record no longer exists, so it cannot be passed as the current name.
    h.expect_code(
        h.close_player_ix(&nameless.pubkey(), Some("zed")),
        &[&nameless],
        ACCOUNT_NOT_INITIALIZED,
    );
    let result = h.send(h.close_player_ix(&nameless.pubkey(), None), &[&nameless]);
    assert_eq!(result.map(|_| ()), Ok(()));
}

// ---- bets ----

#[test]
fn place_bet_enforces_limits_window_balance_and_solvency() {
    let mut h = Harness::new();
    let round_id = h.open_round([1; 32]);
    let player = h.player("gina", 3 * SOL);
    let bet = |h: &Harness, stake: u64, auto: u64| {
        h.place_bet_ix(&player.pubkey(), &player.pubkey(), round_id, stake, auto)
    };

    // Empty bank: the vault cannot cover the exposure.
    h.expect_err(bet(&h, SOL, 0), &[&player], CrashError::InsufficientBank);
    h.deposit(500 * SOL);

    h.expect_err(
        bet(&h, LIMITS.min_stake - 1, 0),
        &[&player],
        CrashError::StakeBelowMinimum,
    );
    h.expect_err(
        bet(&h, SOL + 1, 0),
        &[&player],
        CrashError::StakeAboveMaximum,
    );
    h.expect_err(
        bet(&h, SOL, 15_050),
        &[&player],
        CrashError::AutoCashOutNotCentiPrecise,
    );
    h.expect_err(
        bet(&h, SOL, 10_000),
        &[&player],
        CrashError::AutoCashOutBelowMinimum,
    );
    h.expect_err(
        bet(&h, SOL, 1_000_100),
        &[&player],
        CrashError::AutoCashOutAboveMaximum,
    );
    let poor = h.player("hank", SOL / 2);
    h.expect_err(
        h.place_bet_ix(&poor.pubkey(), &poor.pubkey(), round_id, SOL / 2 + 1, 0),
        &[&poor],
        CrashError::InsufficientBalance,
    );

    h.bet(&player, round_id, SOL, 20_000);
    let state = h.player_state(&player);
    assert_eq!(state.balance, 2 * SOL);
    let active = state.active_bet.unwrap();
    assert_eq!(
        (
            active.round_id,
            active.stake,
            active.auto_cash_out,
            active.exposure
        ),
        (round_id, SOL, 20_000, 2 * SOL)
    );
    // One bet per player and round.
    h.expect_err(bet(&h, SOL, 0), &[&player], CrashError::ActiveBetPending);

    // Another wallet cannot bet with this player's balance.
    let stranger = h.wallet();
    h.expect_err(
        h.place_bet_ix(&stranger.pubkey(), &poor.pubkey(), round_id, SOL / 4, 0),
        &[&stranger],
        CrashError::Unauthorized,
    );

    let admin = h.admin.insecure_clone();
    h.send_ok(h.update_config_ix(1, false), &[&admin]);
    h.expect_err(
        h.place_bet_ix(&poor.pubkey(), &poor.pubkey(), round_id, SOL / 4, 0),
        &[&poor],
        CrashError::TooManyBets,
    );
    h.send_ok(h.update_config_ix(MAX_BETS, false), &[&admin]);

    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);
    h.expect_err(
        h.place_bet_ix(&poor.pubkey(), &poor.pubkey(), round_id, SOL / 4, 0),
        &[&poor],
        CrashError::BettingClosed,
    );
}

#[test]
fn round_exposure_limit_is_enforced() {
    let mut h = Harness::new();
    h.deposit(5_000 * SOL);
    let round_id = h.open_round([1; 32]);
    // Each bet without auto reserves 100 SOL; the round allows 1 000 SOL.
    for index in 0..10 {
        let player = h.player(&format!("p{index:02}"), SOL);
        h.bet(&player, round_id, SOL, 0);
    }
    let player = h.player("p10", SOL);
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), &player.pubkey(), round_id, SOL, 0),
        &[&player],
        CrashError::RoundExposureExceeded,
    );
}

#[test]
fn pending_bet_is_settled_and_replaced_in_one_transaction() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let player = h.player("ivan", 2 * SOL);
    let first = h.open_round([1; 32]);
    h.bet(&player, first, SOL / 2, 0);
    h.void_open_round(first);

    let second = h.open_round([2; 32]);
    h.expect_err(
        h.place_bet_ix(&player.pubkey(), &player.pubkey(), second, SOL / 2, 0),
        &[&player],
        CrashError::ActiveBetPending,
    );
    // Settling against the wrong round is refused.
    h.expect_err(
        h.settle_ix(second, &player.pubkey()),
        &[&player],
        CrashError::BetRoundMismatch,
    );
    h.send_many_ok(
        &[
            h.settle_ix(first, &player.pubkey()),
            h.place_bet_ix(&player.pubkey(), &player.pubkey(), second, SOL, 0),
        ],
        &[&player],
    );
    let state = h.player_state(&player);
    assert_eq!(state.balance, SOL);
    assert_eq!(state.active_bet.unwrap().round_id, second);
    assert_eq!(state.total_wagered, 0, "a voided round earns no experience");
}

#[test]
fn voided_round_refunds_exactly() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let round_id = h.open_round([1; 32]);
    let player = h.player("judy", SOL);
    h.bet(&player, round_id, SOL / 2, 0);

    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.close_betting_ix(round_id),
        &[&operator],
        CrashError::BettingStillOpen,
    );
    h.close_betting(round_id);

    let stranger = h.wallet();
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

    h.send_ok(h.settle_ix(round_id, &player.pubkey()), &[&stranger]);
    let state = h.player_state(&player);
    assert_eq!(state.balance, SOL);
    assert_eq!((state.total_wagered, state.bets_settled), (0, 0));
    h.expect_err(
        h.settle_ix(round_id, &player.pubkey()),
        &[&stranger],
        CrashError::NoActiveBet,
    );
    assert_eq!(h.fetch::<HouseVault>(&vault_pda()).reserved_exposure, 0);

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

    let early = h.player("early", 2 * SOL); // manual cash-out at the first tick >= 2.00x
    let auto = h.player("auto", 2 * SOL); // auto at 2.50x
    let late = h.player("late", 2 * SOL); // manual cash-out at the crash tick: loses
    let holder = h.player("holder", 2 * SOL); // never cashes out: loses
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
    h.cash_out(&early, round_id);
    h.expect_err(
        h.cash_out_ix(&early.pubkey(), &early.pubkey(), round_id),
        &[&early],
        CrashError::AlreadyCashedOut,
    );
    // Nobody can cash out someone else's bet.
    h.expect_err(
        h.cash_out_ix(&late.pubkey(), &holder.pubkey(), round_id),
        &[&late],
        CrashError::Unauthorized,
    );

    // Revealing before the curve reaches the crash point is refused.
    h.expect_err(
        h.reveal_ix(round_id, seed),
        &[&late],
        CrashError::RevealTooEarly,
    );
    h.warp_to_tick(round_id, crash_tick);
    h.cash_out(&late, round_id);
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

    // A forged `Player` account (right layout, wrong address) cannot receive a payout.
    let stranger = h.wallet();
    let mut forged = h.svm.get_account(&player_pda(&early.pubkey())).unwrap();
    forged.lamports += SOL;
    let forged_address = Pubkey::new_unique();
    h.svm.set_account(forged_address, forged).unwrap();
    h.expect_code(
        h.settle_ix_for(round_id, forged_address),
        &[&stranger],
        CONSTRAINT_SEEDS,
    );

    let vault_before = h.lamports(&vault_pda());
    let mut paid_total = 0;
    for player in [&early, &auto, &late, &holder] {
        let bet = h.player_state(player).active_bet.unwrap();
        let expected = crash_rules::settle_bet(
            &RULES,
            bet.stake,
            bet.auto_target(),
            bet.cash_out_tick,
            crash_point,
        )
        .unwrap();
        let before = h.balance(player);
        h.send_ok(h.settle_ix(round_id, &player.pubkey()), &[&stranger]);
        assert_eq!(h.balance(player) - before, expected.payout());
        paid_total += expected.payout();
        // Invariant 13: balance_final = balance_initial - stake + payout.
        assert_eq!(h.balance(player), 2 * SOL - SOL + expected.payout());
        let state = h.player_state(player);
        assert_eq!((state.total_wagered, state.bets_settled), (SOL, 1));
    }
    assert_eq!(vault_before - h.lamports(&vault_pda()), paid_total);
    // The curve jumps from 1.98x to 2.03x, so the first tick at or above 2.00x pays 2.03x.
    let early_multiplier = RULES.recognized_at_tick(two_x_tick).unwrap();
    assert_eq!(early_multiplier, 20_300);
    assert_eq!(h.balance(&early), SOL + SOL * early_multiplier / 10_000);
    assert_eq!(h.balance(&auto), SOL + 5 * SOL / 2);
    assert_eq!(h.balance(&late), SOL);
    assert_eq!(h.balance(&holder), SOL);
    assert_eq!(
        h.fetch::<Round>(&round_pda(round_id)).phase,
        RoundPhase::Settled
    );
    assert_eq!(h.fetch::<HouseVault>(&vault_pda()).reserved_exposure, 0);
    assert_eq!(h.fetch::<HouseConfig>(&config_pda()).current_round, None);
    h.expect_err(
        h.settle_ix(round_id, &early.pubkey()),
        &[&stranger],
        CrashError::NoActiveBet,
    );
}

#[test]
fn unrevealed_round_is_forfeited_in_favor_of_players() {
    let mut h = Harness::new();
    h.deposit(1_000 * SOL);
    let (seed, _) = seed_with_crash_between(0, 10_000, 1_000_000);
    let round_id = h.open_round(seed);
    let cashed = h.player("cashed", SOL);
    let auto = h.player("auto", SOL);
    let holder = h.player("holder", SOL);
    h.bet(&cashed, round_id, SOL, 0);
    h.bet(&auto, round_id, SOL, 50_000);
    h.bet(&holder, round_id, SOL, 0);
    h.close_betting(round_id);
    h.start_round(round_id);
    h.warp_to_tick(round_id, RULES.first_tick_at_least(30_000).unwrap());
    h.cash_out(&cashed, round_id);

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
    for (player, expected) in [
        (&cashed, SOL * multiplier / 10_000),
        (&auto, 5 * SOL),
        (&holder, SOL),
    ] {
        h.settle(round_id, player);
        let state = h.player_state(player);
        assert_eq!(state.balance, expected);
        assert_eq!(
            state.total_wagered, 0,
            "a forfeited round earns no experience"
        );
    }
}

#[test]
fn pause_blocks_entries_but_never_exits() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let (seed, crash_point) = seed_with_crash_between(0, 20_000, 1_000_000);
    let round_id = h.open_round(seed);
    let player = h.player("kate", 2 * SOL);
    let session = Keypair::new();
    h.svm.airdrop(&session.pubkey(), SOL).unwrap();
    h.send_ok(
        h.create_session_ix(
            &player.pubkey(),
            &session.pubkey(),
            h.slot() + 1_000,
            SOL,
            0,
        ),
        &[&player],
    );
    h.bet(&player, round_id, SOL, 0);
    h.close_betting(round_id);
    h.start_round(round_id);

    h.set_paused(true);
    let newcomer = h.wallet();
    h.expect_err(
        h.register_ix(&newcomer.pubkey(), "newbie"),
        &[&newcomer],
        CrashError::Paused,
    );
    h.expect_err(
        h.buy_ix(&player.pubkey(), SOL),
        &[&player],
        CrashError::Paused,
    );
    h.expect_err(
        h.create_session_ix(
            &player.pubkey(),
            &Keypair::new().pubkey(),
            h.slot() + 10,
            1,
            0,
        ),
        &[&player],
        CrashError::Paused,
    );

    h.warp_to_tick(round_id, RULES.first_tick_at_least(15_000).unwrap());
    h.send_ok(
        h.cash_out_ix(&session.pubkey(), &player.pubkey(), round_id),
        &[&session],
    );
    h.warp_to_tick(round_id, RULES.crash_tick(crash_point).unwrap());
    h.send_ok(h.reveal_ix(round_id, seed), &[&player]);
    h.settle(round_id, &player);
    assert!(h.balance(&player) > 2 * SOL);
    h.send_ok(
        h.revoke_ix(&session.pubkey(), &player.pubkey()),
        &[&session],
    );
    let balance = h.balance(&player);
    h.send_ok(h.sell_ix(&player.pubkey(), balance), &[&player]);
    h.send_ok(
        h.close_player_ix(&player.pubkey(), Some("kate")),
        &[&player],
    );
    assert!(!h.exists(&player_pda(&player.pubkey())));

    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 1, [1; 32]),
        &[&operator],
        CrashError::Paused,
    );
}

// ---- randomness (unchanged from v1.1) ----

#[test]
fn randomness_account_is_controlled_by_the_program_pda() {
    let mut h = Harness::without_randomness();
    let operator = h.operator.insecure_clone();
    h.expect_err(
        h.open_round_ix(&operator.pubkey(), 0, [1; 32]),
        &[&operator],
        CrashError::RandomnessNotConfigured,
    );

    let stranger = h.wallet();
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
    let player = h.player("liam", SOL);
    h.bet(&player, round_id, SOL, 0);
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);

    let stranger = h.wallet();
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
    let player = h.player("mia", SOL);
    h.bet(&player, round_id, SOL, 0);

    let round: Round = h.fetch(&round_pda(round_id));
    let stuck_after = round.betting_end_slot + TIMEOUTS.entropy_timeout_slots;
    let stranger = h.wallet();
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
    h.send_ok(h.settle_ix(round_id, &player.pubkey()), &[&stranger]);
    assert_eq!(h.balance(&player), SOL);
    assert_eq!(h.player_state(&player).active_bet, None);
}

/// Real Switchboard costs measured on devnet (docs/spikes/vrf-devnet.md).
const DEVNET_COMMIT_CU: u64 = 15_109;
const DEVNET_REVEAL_CU: u64 = 41_934;
const DEFAULT_CU_LIMIT: u64 = 200_000;

#[test]
fn instructions_fit_the_default_compute_budget() {
    let mut h = Harness::new();
    h.deposit(500 * SOL);
    let owner = h.wallet();
    let session = Keypair::new();
    let onboarding = h.send_many_ok(
        &[
            h.register_ix(&owner.pubkey(), "nora"),
            h.buy_ix(&owner.pubkey(), SOL),
            h.create_session_ix(
                &owner.pubkey(),
                &session.pubkey(),
                h.slot() + 1_000,
                SOL,
                FEE_BUDGET,
            ),
        ],
        &[&owner],
    );
    let round_id = h.open_round([1; 32]);
    let bet = h.send_ok(
        h.place_bet_ix(&session.pubkey(), &owner.pubkey(), round_id, SOL / 2, 0),
        &[&session],
    );
    let round: Round = h.fetch(&round_pda(round_id));
    h.warp(round.betting_end_slot);
    let operator = h.operator.insecure_clone();
    let close = h.send_ok(h.close_betting_ix(round_id), &[&operator]);
    h.warp(h.slot() + 2);
    let start = h.send_ok(
        h.start_round_ix(&operator.pubkey(), round_id, VRF_OUTPUT),
        &[&operator],
    );
    println!(
        "compute units: onboarding {onboarding}, place_bet {bet}, close_betting {close} and \
         start_round {start} (with the mock)"
    );
    assert!(onboarding < DEFAULT_CU_LIMIT);
    assert!(bet < DEFAULT_CU_LIMIT);
    // The mock's own cost is included, so adding the real Switchboard cost is an upper bound.
    assert!(close + DEVNET_COMMIT_CU < DEFAULT_CU_LIMIT);
    assert!(start + DEVNET_REVEAL_CU < DEFAULT_CU_LIMIT);
}
