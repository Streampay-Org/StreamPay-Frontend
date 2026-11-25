//! Integration tests for `Contract::withdraw_to`.
//!
//! Covers recipient-only authorisation, destination trustline enforcement,
//! fee split, settlement transitions, event emission, and edge cases.

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{
    Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{contract, contractimpl, Address, Env, IntoVal, Symbol, TryFromVal, Val};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

// ── Shared fixture ────────────────────────────────────────────────────────────

/// Decodes the symbol at `index` of an event's topic list, if present.
///
/// `Val` is not `PartialEq` in Soroban SDK 23, so topics are compared as
/// decoded [`Symbol`]s instead of raw host values.
fn topic_symbol(env: &Env, topics: &soroban_sdk::Vec<Val>, index: u32) -> Option<Symbol> {
    topics
        .get(index)
        .and_then(|value| Symbol::try_from_val(env, &value).ok())
}

struct TestFixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    destination: Address,
    token: Address,
    contract_id: Address,
    client: ContractClient<'static>,
}

fn setup() -> TestFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let destination = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    client.initialize(&admin);

    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);

    TestFixture {
        env,
        admin,
        sender,
        recipient,
        destination,
        token,
        contract_id,
        client,
    }
}

fn create_default_stream(f: &TestFixture, fee_bps: u32) -> u64 {
    // 1_000 tokens over [1_000, 2_000] (1 token/sec).
    f.client.create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000i128,
        &1_000u64,
        &2_000u64,
        &fee_bps,
    )
}

// ── Mock token for missing-trustline testing ──────────────────────────────────
//
// `require_recipient_trustline` probes `token::Client::balance(destination)`
// and returns `Error::RecipientTrustlineMissing` when the balance is negative.
// This minimal SEP-41-compatible mock returns `-1` for any address configured
// as missing a trustline while supporting `transfer` for stream creation.

#[contract]
struct MockTrustlineToken;

#[contractimpl]
impl MockTrustlineToken {
    pub fn set_untrusted(env: Env, addr: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "untrusted"), &addr);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        if let Some(untrusted) = env
            .storage()
            .instance()
            .get::<Symbol, Address>(&Symbol::new(&env, "untrusted"))
        {
            if id == untrusted {
                return -1;
            }
        }
        1_000_000
    }

    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

// ── Happy path & event payload ────────────────────────────────────────────────

#[test]
fn withdraw_to_transfers_to_destination_and_emits_withdrawn_to_event() {
    let f = setup();
    let id = create_default_stream(&f, 0);

    // Advance to midpoint (t = 1_500 -> 500 tokens vested).
    f.env.ledger().set_timestamp(1_500);

    let withdrawn = f.client.withdraw_to(&id, &300i128, &f.destination);
    assert_eq!(withdrawn, 300);

    // `Events::all` only reports the events of the most recent invocation, so
    // capture them before any further contract call.
    let events = f.env.events().all();

    let tkn = TokenClient::new(&f.env, &f.token);
    assert_eq!(tkn.balance(&f.destination), 300);
    assert_eq!(tkn.balance(&f.recipient), 0);
    assert_eq!(tkn.balance(&f.contract_id), 700);

    let stream = f.client.get_stream(&id);
    assert_eq!(stream.released_amount, 300);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(stream.last_update, 1_500);

    // Verify the emitted `("stream", "withdrawn_to")` event includes `destination`.
    let withdrawn_to_topic = Symbol::new(&f.env, "withdrawn_to");
    let stream_topic = Symbol::new(&f.env, "stream");

    let matching_count = events
        .iter()
        .filter(|e| {
            e.1.len() == 2
                && topic_symbol(&f.env, &e.1, 0) == Some(stream_topic.clone())
                && topic_symbol(&f.env, &e.1, 1) == Some(withdrawn_to_topic.clone())
        })
        .count();
    assert_eq!(matching_count, 1);
}

// ── Authorisation: recipient only ─────────────────────────────────────────────

#[test]
fn withdraw_to_succeeds_with_recipient_auth_only() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "withdraw_to",
        args: (id, 250i128, f.destination.clone()).into_val(&f.env),
        sub_invokes: &[],
    };

    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &invoke,
    }]);

    let amount = f.client.withdraw_to(&id, &250i128, &f.destination);
    assert_eq!(amount, 250);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.destination), 250);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn withdraw_to_rejects_sender_auth() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "withdraw_to",
        args: (id, 250i128, f.destination.clone()).into_val(&f.env),
        sub_invokes: &[],
    };

    // Sender cannot redirect recipient's funds.
    f.env.mock_auths(&[MockAuth {
        address: &f.sender,
        invoke: &invoke,
    }]);

    f.client.withdraw_to(&id, &250i128, &f.destination);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn withdraw_to_rejects_allowlisted_withdrawer_auth() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    let allowlisted = Address::generate(&f.env);
    f.client.add_withdrawer(&id, &allowlisted);
    f.env.ledger().set_timestamp(1_500);

    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "withdraw_to",
        args: (id, 250i128, f.destination.clone()).into_val(&f.env),
        sub_invokes: &[],
    };

    // Even an allowlisted withdrawer cannot call `withdraw_to` to redirect funds.
    f.env.mock_auths(&[MockAuth {
        address: &allowlisted,
        invoke: &invoke,
    }]);

    f.client.withdraw_to(&id, &250i128, &f.destination);
}

// ── Missing destination trustline ─────────────────────────────────────────────

#[test]
fn withdraw_to_missing_destination_trustline_returns_error_and_moves_nothing() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let untrusted_dest = Address::generate(&env);

    let mock_token_id = env.register(MockTrustlineToken, ());
    let mock_token = MockTrustlineTokenClient::new(&env, &mock_token_id);
    mock_token.set_untrusted(&untrusted_dest);

    client.initialize(&admin);
    let id = client.create_stream(
        &sender,
        &recipient,
        &mock_token_id,
        &1_000i128,
        &1_000u64,
        &2_000u64,
        &0u32,
    );

    env.ledger().set_timestamp(1_500);

    let err = client
        .try_withdraw_to(&id, &250i128, &untrusted_dest)
        .expect_err("missing destination trustline must fail");
    assert_eq!(err, Ok(Error::RecipientTrustlineMissing));

    // Stream accounting is completely unchanged and no events were emitted.
    let stream = client.get_stream(&id);
    assert_eq!(stream.released_amount, 0);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(env.events().all().len(), 0);
}

// ── Fee split ─────────────────────────────────────────────────────────────────

#[test]
fn withdraw_to_fee_split_pays_net_to_destination_and_fee_to_collector() {
    let f = setup();
    let collector = Address::generate(&f.env);
    f.client.set_fee_collector(&f.admin, &collector);

    // 500 bps = 5% fee.
    let id = create_default_stream(&f, 500);
    f.env.ledger().set_timestamp(1_500);

    let gross = f.client.withdraw_to(&id, &400i128, &f.destination);
    assert_eq!(gross, 400);

    let tkn = TokenClient::new(&f.env, &f.token);
    // 5% of 400 = 20 fee, 380 net.
    assert_eq!(tkn.balance(&collector), 20);
    assert_eq!(tkn.balance(&f.destination), 380);
    assert_eq!(tkn.balance(&f.recipient), 0);
}

// ── Final withdrawal settles stream & decrements counter ──────────────────────

#[test]
fn withdraw_to_final_withdrawal_settles_stream_and_decrements_sender_count() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    assert_eq!(f.client.sender_stream_count(&f.sender), 1);

    // Partial withdrawal at midpoint.
    f.env.ledger().set_timestamp(1_500);
    f.client.withdraw_to(&id, &400i128, &f.destination);
    assert_eq!(f.client.get_stream(&id).status, StreamStatus::Active);
    assert_eq!(f.client.sender_stream_count(&f.sender), 1);

    // Final withdrawal at end_time settles the stream.
    f.env.ledger().set_timestamp(2_000);
    let final_amt = f.client.withdraw_to(&id, &600i128, &f.destination);
    assert_eq!(final_amt, 600);
    let events = f.env.events().all();

    let stream = f.client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Settled);
    assert_eq!(stream.released_amount, 1_000);
    assert_eq!(f.client.sender_stream_count(&f.sender), 0);

    let tkn = TokenClient::new(&f.env, &f.token);
    assert_eq!(tkn.balance(&f.destination), 1_000);
    assert_eq!(tkn.balance(&f.contract_id), 0);

    // Both `withdrawn_to` and `settled` events are emitted.
    let stream_topic = Symbol::new(&f.env, "stream");
    let withdrawn_to_topic = Symbol::new(&f.env, "withdrawn_to");
    let settled_topic = Symbol::new(&f.env, "settled");

    assert!(events
        .iter()
        .any(|e| topic_symbol(&f.env, &e.1, 0) == Some(Symbol::new(&f.env, "stream"))
            && topic_symbol(&f.env, &e.1, 1) == Some(Symbol::new(&f.env, "withdrawn_to"))));
    assert!(events
        .iter()
        .any(|e| topic_symbol(&f.env, &e.1, 0) == Some(Symbol::new(&f.env, "stream"))
            && topic_symbol(&f.env, &e.1, 1) == Some(Symbol::new(&f.env, "settled"))));

    // Subsequent withdrawal on settled stream returns AlreadySettled.
    let err = f
        .client
        .try_withdraw_to(&id, &1i128, &f.destination)
        .expect_err("settled stream must reject withdraw_to");
    assert_eq!(err, Ok(Error::AlreadySettled));
}

// ── Edge cases ────────────────────────────────────────────────────────────────

#[test]
fn withdraw_to_destination_equals_recipient() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let amount = f.client.withdraw_to(&id, &500i128, &f.recipient);
    assert_eq!(amount, 500);
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 500);
    assert_eq!(f.client.get_stream(&id).released_amount, 500);
}

#[test]
fn withdraw_to_destination_is_contract_address() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let tkn = TokenClient::new(&f.env, &f.token);
    let before = tkn.balance(&f.contract_id);

    let amount = f.client.withdraw_to(&id, &200i128, &f.contract_id);
    assert_eq!(amount, 200);
    // Self-transfer keeps contract token balance unchanged while accounting advances.
    assert_eq!(tkn.balance(&f.contract_id), before);
    assert_eq!(f.client.get_stream(&id).released_amount, 200);
}

#[test]
fn withdraw_to_over_withdraw_fails() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let err = f
        .client
        .try_withdraw_to(&id, &501i128, &f.destination)
        .expect_err("over-withdraw must fail");
    assert_eq!(err, Ok(Error::OverWithdraw));
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.destination), 0);
}

#[test]
fn withdraw_to_paused_contract_fails() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    f.client.set_paused(&f.admin, &true);

    let err = f
        .client
        .try_withdraw_to(&id, &100i128, &f.destination)
        .expect_err("paused contract must reject withdraw_to");
    assert_eq!(err, Ok(Error::ContractPaused));
    assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.destination), 0);
}

#[test]
fn withdraw_to_invalid_amount_and_not_found() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let err_zero = f
        .client
        .try_withdraw_to(&id, &0i128, &f.destination)
        .expect_err("zero amount must fail");
    assert_eq!(err_zero, Ok(Error::InvalidAmount));

    let err_neg = f
        .client
        .try_withdraw_to(&id, &-10i128, &f.destination)
        .expect_err("negative amount must fail");
    assert_eq!(err_neg, Ok(Error::InvalidAmount));

    let err_missing = f
        .client
        .try_withdraw_to(&9999u64, &100i128, &f.destination)
        .expect_err("nonexistent stream must fail");
    assert_eq!(err_missing, Ok(Error::NotFound));
}

// ── Existing `withdraw` behaviour & event unchanged ───────────────────────────

#[test]
fn withdraw_existing_behaviour_and_event_unchanged() {
    let f = setup();
    let id = create_default_stream(&f, 0);
    f.env.ledger().set_timestamp(1_500);

    let amount = f.client.withdraw(&f.recipient, &id, &300i128);
    assert_eq!(amount, 300);
    let events = f.env.events().all();

    let tkn = TokenClient::new(&f.env, &f.token);
    assert_eq!(tkn.balance(&f.recipient), 300);
    assert_eq!(tkn.balance(&f.destination), 0);

    let stream_topic = Symbol::new(&f.env, "stream");
    let withdrawn_topic = Symbol::new(&f.env, "withdrawn");
    let withdrawn_to_topic = Symbol::new(&f.env, "withdrawn_to");

    assert!(events
        .iter()
        .any(|e| topic_symbol(&f.env, &e.1, 0) == Some(Symbol::new(&f.env, "stream"))
            && topic_symbol(&f.env, &e.1, 1) == Some(Symbol::new(&f.env, "withdrawn"))));
    assert!(!events
        .iter()
        .any(|e| topic_symbol(&f.env, &e.1, 0) == Some(Symbol::new(&f.env, "stream"))
            && topic_symbol(&f.env, &e.1, 1) == Some(Symbol::new(&f.env, "withdrawn_to"))));
}
