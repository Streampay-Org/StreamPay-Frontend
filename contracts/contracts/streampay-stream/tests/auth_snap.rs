//! # Per-entrypoint authorisation snapshots for `streampay-stream`
//!
//! Integration tests that verify every state-changing entrypoint enforces
//! the correct `require_auth` guard.  Each test:
//!
//! 1. Sets up the contract with `mock_all_auths()` so that setup succeeds.
//! 2. Clears all mocked auths before the entrypoint under test.
//! 3. Asserts the entrypoint panics with `HostError: Error(Auth, InvalidAction)`.
//!
//! ## Running
//!
//! ```text
//! cargo test --test auth_snap
//! ```
//!
//! ## Coverage
//!
//! - Every entrypoint documented with `@custom:auth` in `lib.rs` is covered.
//! - Read-only views are *not* covered — they require no auth by design.
//!
//! ## Adding a new entrypoint
//!
//! When a new state-changing entrypoint is added, a corresponding
//! `auth_snap_{name}` test must be added here.

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient};

// ── Shared test helpers ────────────────────────────────────────────────────────

/// All addresses and tokens needed by a single auth-snapshot test.
struct AuthTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
    org: Address,
}

fn auth_setup() -> AuthTestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let org = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000);

    AuthTestData {
        env,
        admin,
        sender,
        recipient,
        token,
        org,
    }
}

fn auth_client(env: &Env) -> ContractClient<'_> {
    let contract_id = env.register(Contract, ());
    ContractClient::new(env, &contract_id)
}

/// Helper: initialize the contract and return a client.
fn auth_initialized(data: &AuthTestData) -> ContractClient<'_> {
    let client = auth_client(&data.env);
    client.initialize(&data.admin);
    client
}

/// Helper: initialize + create a funded active stream, return (client, stream_id).
fn auth_with_stream(data: &AuthTestData) -> (ContractClient<'_>, u64) {
    let client = auth_initialized(data);
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    (client, id)
}

fn make_draft(data: &AuthTestData) -> (ContractClient<'_>, u64) {
    let client = auth_initialized(data);
    let id = client.create_draft_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &100u64,
    );
    (client, id)
}

// ── Admin / deployment entrypoint auth snapshots ───────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_initialize() {
    let data = auth_setup();
    let client = auth_client(&data.env);

    data.env.mock_auths(&[]);
    client.initialize(&data.admin);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_init_with_token_allowlist() {
    let data = auth_setup();
    let client = auth_client(&data.env);

    let mut tokens = soroban_sdk::Vec::new(&data.env);
    tokens.push_back(data.token.clone());

    data.env.mock_auths(&[]);
    client.init_with_token_allowlist(&data.admin, &tokens);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_init_allowlist_for_org() {
    let data = auth_setup();
    let client = auth_client(&data.env);

    let mut tokens = soroban_sdk::Vec::new(&data.env);
    tokens.push_back(data.token.clone());
    let mut org_tokens = soroban_sdk::Vec::new(&data.env);
    org_tokens.push_back(data.token.clone());

    data.env.mock_auths(&[]);
    client.init_allowlist_for_org(&data.admin, &tokens, &data.org, &org_tokens);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_paused() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_paused(&data.admin, &true);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_admin() {
    let data = auth_setup();
    let client = auth_initialized(&data);
    let new_admin = Address::generate(&data.env);

    data.env.mock_auths(&[]);
    client.set_admin(&data.admin, &new_admin);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_token_allowed() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_token_allowed(&data.admin, &data.token, &true);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_org_token_allowed() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_org_token_allowed(&data.admin, &data.org, &data.token, &true);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_fee_collector() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_fee_collector(&data.admin, &data.admin);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_default_fee_bps() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_default_fee_bps(&data.admin, &100);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_fee_bps() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_fee_bps(&data.admin, &100);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_max_streams_per_sender() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_max_streams_per_sender(&data.admin, &20);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_set_cooloff_duration() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.set_cooloff_duration(&data.admin, &3_600);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_upgrade() {
    let data = auth_setup();
    let client = auth_initialized(&data);
    let new_wasm_hash = data.env.deployer().upload_contract_wasm(&[] as &[u8]);

    data.env.mock_auths(&[]);
    client.upgrade(&data.admin, &new_wasm_hash);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_migrate() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.migrate(&data.admin);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_sweep_fees() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let mut stream_ids = soroban_sdk::Vec::new(&data.env);
    stream_ids.push_back(1u64);

    data.env.mock_auths(&[]);
    client.sweep_fees(&data.admin, &stream_ids);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_admin_override() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);

    data.env.mock_auths(&[]);
    client.admin_override(&data.admin, &0, &id, &3_100u64);
}

// ── Stream lifecycle entrypoint auth snapshots (sender-gated) ──────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_create_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_create_stream_for_org() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    client.set_org_token_allowed(&data.admin, &data.org, &data.token, &true);

    data.env.mock_auths(&[]);
    client.create_stream_for_org(
        &data.org,
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_create_draft_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.create_draft_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &100u64,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_start_stream() {
    let data = auth_setup();
    let (client, draft_id) = make_draft(&data);

    data.env.mock_auths(&[]);
    client.start_stream(&draft_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_add_withdrawer() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    let withdrawer = Address::generate(&data.env);

    data.env.mock_auths(&[]);
    client.add_withdrawer(&id, &withdrawer);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_remove_withdrawer() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    let withdrawer = Address::generate(&data.env);

    // Add the withdrawer first (with mock auths)
    client.add_withdrawer(&id, &withdrawer);

    data.env.mock_auths(&[]);
    client.remove_withdrawer(&id, &withdrawer);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_pause() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    data.env.ledger().set_timestamp(1_600);

    data.env.mock_auths(&[]);
    client.pause(&id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_resume() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    data.env.ledger().set_timestamp(1_600);

    // Pause first (with mock auths)
    client.pause(&id);
    data.env.ledger().set_timestamp(1_700);

    data.env.mock_auths(&[]);
    client.resume(&id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_cancel_stream() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);

    data.env.mock_auths(&[]);
    client.cancel_stream(&id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_amend_stream() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);

    data.env.mock_auths(&[]);
    client.amend_stream(&id, &10i128, &2_600u64);
}

// ── Recipient-gated entrypoint auth snapshots ──────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_withdraw() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    data.env.ledger().set_timestamp(1_600);

    data.env.mock_auths(&[]);
    client.withdraw(&data.recipient, &id, &250i128);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_withdraw_with_max_fee_bps() {
    let data = auth_setup();
    let (client, id) = auth_with_stream(&data);
    data.env.ledger().set_timestamp(1_600);

    data.env.mock_auths(&[]);
    client.withdraw_with_max_fee_bps(&id, &250i128, &200);
}

// ── Multi-recipient (split stream) auth snapshots ──────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_create_split_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let mut recipients = soroban_sdk::Vec::new(&data.env);
    recipients.push_back(data.recipient.clone());
    recipients.push_back(Address::generate(&data.env));
    let mut weights = soroban_sdk::Vec::new(&data.env);
    weights.push_back(5000u64);
    weights.push_back(5000u64);

    data.env.mock_auths(&[]);
    client.create_split_stream(
        &data.sender,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &recipients,
        &weights,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_withdraw_split() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let mut recipients = soroban_sdk::Vec::new(&data.env);
    recipients.push_back(data.recipient.clone());
    recipients.push_back(Address::generate(&data.env));
    let mut weights = soroban_sdk::Vec::new(&data.env);
    weights.push_back(5000u64);
    weights.push_back(5000u64);

    let id = client.create_split_stream(
        &data.sender,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &recipients,
        &weights,
    );
    data.env.ledger().set_timestamp(1_600);

    data.env.mock_auths(&[]);
    client.withdraw_split(&id, &data.recipient, &100i128);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_cancel_split_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let mut recipients = soroban_sdk::Vec::new(&data.env);
    recipients.push_back(data.recipient.clone());
    recipients.push_back(Address::generate(&data.env));
    let mut weights = soroban_sdk::Vec::new(&data.env);
    weights.push_back(5000u64);
    weights.push_back(5000u64);

    let id = client.create_split_stream(
        &data.sender,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &recipients,
        &weights,
    );
    data.env.ledger().set_timestamp(1_600);

    data.env.mock_auths(&[]);
    client.cancel_split_stream(&id);
}

// ── Recurring stream auth snapshots ────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_create_recurring_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    data.env.mock_auths(&[]);
    client.create_recurring_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100i128,
        &1_000u64,
        &10u64,
        &1_100u64,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_withdraw_recurring() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let id = client.create_recurring_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100i128,
        &1_000u64,
        &10u64,
        &1_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_100 + 3 * 1_000);
    client.process_recurring_stream(&id);

    data.env.mock_auths(&[]);
    client.withdraw_recurring(&id, &data.recipient, &100i128);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn auth_snap_cancel_recurring_stream() {
    let data = auth_setup();
    let client = auth_initialized(&data);

    let id = client.create_recurring_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100i128,
        &1_000u64,
        &10u64,
        &1_100u64,
        &0u32,
    );

    data.env.mock_auths(&[]);
    client.cancel_recurring_stream(&id);
}

// ── Combined: every auth-gated entrypoint panics with no auth provided ────────

#[test]
fn auth_snap_initialize_missing_auth_fails() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);

    env.mock_auths(&[]);
    let result = client.try_initialize(&admin);
    assert!(result.is_err());
}
