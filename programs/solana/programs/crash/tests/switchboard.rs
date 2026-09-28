//! Conformance of the hand-written Switchboard adapter (`src/switchboard.rs`) with the real program:
//! the on-chain IDL pinned in `fixtures/switchboard-randomness-idl.json` and a randomness account
//! fetched from devnet during the VRF spike (`fixtures/switchboard-randomness-account-devnet.hex`).

use anchor_lang::prelude::Pubkey;
use crash::switchboard::{self, InstructionSpec, Randomness};
use serde_json::Value;

const IDL: &str = include_str!("fixtures/switchboard-randomness-idl.json");
const DEVNET_ACCOUNT_HEX: &str = include_str!("fixtures/switchboard-randomness-account-devnet.hex");

fn idl() -> Value {
    serde_json::from_str(IDL).expect("valid IDL JSON")
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .expect("byte array")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect()
}

fn devnet_account() -> Vec<u8> {
    let hex = DEVNET_ACCOUNT_HEX.trim();
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn program_id_matches_the_idl() {
    assert_eq!(
        idl()["address"].as_str().unwrap(),
        switchboard::PROGRAM_ID.to_string()
    );
}

#[test]
fn instruction_specs_match_the_idl() {
    let idl = idl();
    let specs: [&InstructionSpec; 3] = [
        &switchboard::RANDOMNESS_INIT,
        &switchboard::RANDOMNESS_COMMIT,
        &switchboard::RANDOMNESS_REVEAL,
    ];
    for spec in specs {
        let ix = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ix| ix["name"] == spec.name)
            .unwrap_or_else(|| panic!("{} in IDL", spec.name));
        assert_eq!(
            bytes(&ix["discriminator"]),
            spec.discriminator,
            "{}",
            spec.name
        );

        let accounts = ix["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), spec.accounts.len(), "{}", spec.name);
        for (expected, actual) in accounts.iter().zip(spec.accounts) {
            assert_eq!(expected["name"], actual.name, "{}", spec.name);
            let flag = |name: &str| expected[name].as_bool().unwrap_or(false);
            assert_eq!(
                flag("signer"),
                actual.signer,
                "{}.{}",
                spec.name,
                actual.name
            );
            assert_eq!(
                flag("writable"),
                actual.writable,
                "{}.{}",
                spec.name,
                actual.name
            );
            if let Some(address) = expected["address"].as_str() {
                let pinned = match actual.name {
                    "recent_slothashes" => switchboard::SLOT_HASHES_SYSVAR,
                    "system_program" => anchor_lang::solana_program::system_program::ID,
                    "token_program" => switchboard::TOKEN_PROGRAM,
                    "associated_token_program" => switchboard::ASSOCIATED_TOKEN_PROGRAM,
                    "wrapped_sol_mint" => switchboard::WRAPPED_SOL_MINT,
                    "address_lookup_table_program" => switchboard::ADDRESS_LOOKUP_TABLE_PROGRAM,
                    other => panic!("unexpected fixed account {other}"),
                };
                assert_eq!(address, pinned.to_string(), "{}.{}", spec.name, actual.name);
            }
        }
    }
}

#[test]
fn instruction_args_match_the_idl_types() {
    let idl = idl();
    let fields = |name: &str| -> Vec<(String, String)> {
        idl["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()["type"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["name"].as_str().unwrap().into(), f["type"].to_string()))
            .collect()
    };
    assert_eq!(fields("RandomnessCommitParams"), vec![]);
    assert_eq!(
        fields("RandomnessInitParams"),
        vec![("recent_slot".into(), "\"u64\"".into())]
    );
    assert_eq!(
        fields("RandomnessRevealParams"),
        vec![
            ("signature".into(), r#"{"array":["u8",64]}"#.into()),
            ("recovery_id".into(), "\"u8\"".into()),
            ("value".into(), r#"{"array":["u8",32]}"#.into()),
        ]
    );
    let args = switchboard::reveal_args(&[1; 64], 2, &[3; 32]);
    assert_eq!(args.len(), 97);
    assert_eq!(
        (args[0], args[63], args[64], args[65], args[96]),
        (1, 1, 2, 3, 3)
    );

    let ix = switchboard::instruction(
        &switchboard::RANDOMNESS_REVEAL,
        &[Pubkey::default(); 12],
        &args,
    );
    assert_eq!(ix.program_id, switchboard::PROGRAM_ID);
    // 105 bytes, as in the reveal transactions observed on devnet.
    assert_eq!(ix.data.len(), 105);
    assert_eq!(ix.data[..8], switchboard::RANDOMNESS_REVEAL.discriminator);
}

#[test]
fn account_layout_matches_the_idl() {
    let idl = idl();
    let account = idl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "RandomnessAccountData")
        .unwrap();
    assert_eq!(
        bytes(&account["discriminator"]),
        switchboard::RANDOMNESS_ACCOUNT_DISCRIMINATOR
    );

    let size_of = |ty: &Value| match ty.as_str() {
        Some("pubkey") => 32,
        Some("u64" | "i64") => 8,
        _ => ty["array"][1].as_u64().expect("array length") as usize,
    };
    let mut offset = 8; // discriminator
    let mut offsets = std::collections::HashMap::new();
    let ty = idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "RandomnessAccountData")
        .unwrap();
    for field in ty["type"]["fields"].as_array().unwrap() {
        offsets.insert(field["name"].as_str().unwrap().to_string(), offset);
        offset += size_of(&field["type"]);
    }
    assert_eq!(offset, 480, "account size observed on devnet");
    assert_eq!(offsets["authority"], switchboard::AUTHORITY_OFFSET);
    assert_eq!(offsets["queue"], switchboard::QUEUE_OFFSET);
    assert_eq!(offsets["seed_slot"], switchboard::SEED_SLOT_OFFSET);
    assert_eq!(offsets["reveal_slot"], switchboard::REVEAL_SLOT_OFFSET);
    assert_eq!(offsets["value"], switchboard::VALUE_OFFSET);
}

#[test]
fn parses_a_real_devnet_randomness_account() {
    let data = devnet_account();
    assert_eq!(data.len(), 480);
    let parsed = Randomness::parse(&switchboard::PROGRAM_ID, &data).expect("valid account");
    // Values decoded independently with the Switchboard TypeScript SDK during the spike.
    assert_eq!(
        parsed.authority.to_string(),
        "3R48JPhp8zkRokLdGJx8rFDT53CiKz92BYJErkipzpqV"
    );
    assert_eq!(
        parsed.queue.to_string(),
        "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"
    );
    assert_eq!(parsed.seed_slot, 505_266_945);
    assert_eq!(parsed.reveal_slot, 505_267_002);
    let value: String = parsed.value.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        value,
        "e1aac4153217193a2b04fb9b7c47d12c29d29461a071aa630d44b50c82e0e677"
    );
}

#[test]
fn rejects_foreign_owner_discriminator_and_short_data() {
    let data = devnet_account();
    // Same bytes owned by another program: a forged account (the crate's parse would accept it).
    assert_eq!(Randomness::parse(&Pubkey::new_unique(), &data), None);
    let mut wrong_discriminator = data.clone();
    wrong_discriminator[0] ^= 1;
    assert_eq!(
        Randomness::parse(&switchboard::PROGRAM_ID, &wrong_discriminator),
        None
    );
    assert_eq!(
        Randomness::parse(
            &switchboard::PROGRAM_ID,
            &data[..switchboard::RANDOMNESS_MIN_LEN - 1]
        ),
        None
    );
}
