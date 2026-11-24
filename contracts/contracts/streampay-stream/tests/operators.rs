//! Integration tests for per-stream pause/resume operators.

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, IntoVal, Symbol};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus, MAX_OPERATORS};

struct TestContext {
    env: Env,
    sender: Address,
    recipient: Address,
    contract_id: Address,
    stream_id: u64,
}

fn setup() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    TestContext {
        env,
        sender,
        recipient,
        contract_id,
        stream_id,
    }
}

#[test]
fn operator_can_pause_and_resume_stream() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let operator = Address::generate(&ctx.env);

    client.set_operator(&ctx.stream_id, &operator);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), 1);
    assert!(client.get_operators(&ctx.stream_id).contains(&operator));

    // Advance into active window and pause as operator.
    ctx.env.ledger().set_timestamp(1_500);
    let paused = client.pause_as(&operator, &ctx.stream_id);
    assert_eq!(paused.status, StreamStatus::Paused);
    assert_eq!(paused.paused_at, 1_500);

    // Advance 200 seconds and resume as operator.
    ctx.env.ledger().set_timestamp(1_700);
    let resumed = client.resume_as(&operator, &ctx.stream_id);
    assert_eq!(resumed.status, StreamStatus::Active);
    assert_eq!(resumed.paused_at, 0);
    assert_eq!(resumed.total_paused_duration, 200);
    assert_eq!(resumed.end_time, 2_300);
}

#[test]
fn sender_pause_and_resume_unchanged() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);

    ctx.env.ledger().set_timestamp(1_500);
    let paused = client.pause(&ctx.stream_id);
    assert_eq!(paused.status, StreamStatus::Paused);

    ctx.env.ledger().set_timestamp(1_650);
    let resumed = client.resume(&ctx.stream_id);
    assert_eq!(resumed.status, StreamStatus::Active);
    assert_eq!(resumed.end_time, 2_250);
}

#[test]
fn sender_can_also_use_pause_as_and_resume_as() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);

    ctx.env.ledger().set_timestamp(1_500);
    let paused = client.pause_as(&ctx.sender, &ctx.stream_id);
    assert_eq!(paused.status, StreamStatus::Paused);

    ctx.env.ledger().set_timestamp(1_600);
    let resumed = client.resume_as(&ctx.sender, &ctx.stream_id);
    assert_eq!(resumed.status, StreamStatus::Active);
    assert_eq!(resumed.end_time, 2_200);
}

#[test]
fn unauthorized_caller_cannot_pause_or_resume() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let stranger = Address::generate(&ctx.env);

    ctx.env.ledger().set_timestamp(1_500);
    assert_eq!(
        client.try_pause_as(&stranger, &ctx.stream_id),
        Err(Ok(Error::Unauthorized))
    );

    client.pause(&ctx.stream_id);
    ctx.env.ledger().set_timestamp(1_600);
    assert_eq!(
        client.try_resume_as(&stranger, &ctx.stream_id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn removing_operator_immediately_revokes_access() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let operator = Address::generate(&ctx.env);

    client.set_operator(&ctx.stream_id, &operator);
    ctx.env.ledger().set_timestamp(1_500);
    client.pause_as(&operator, &ctx.stream_id);

    // Remove operator while paused — operator can no longer resume.
    client.remove_operator(&ctx.stream_id, &operator);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), 0);

    ctx.env.ledger().set_timestamp(1_600);
    assert_eq!(
        client.try_resume_as(&operator, &ctx.stream_id),
        Err(Ok(Error::Unauthorized))
    );

    // Sender resumes, then operator still cannot pause.
    client.resume(&ctx.stream_id);
    assert_eq!(
        client.try_pause_as(&operator, &ctx.stream_id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn sender_cannot_be_added_as_operator() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);

    assert_eq!(
        client.try_set_operator(&ctx.stream_id, &ctx.sender),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(client.get_operators(&ctx.stream_id).len(), 0);
}

#[test]
fn duplicate_add_and_remove_non_member_are_idempotent() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let operator = Address::generate(&ctx.env);
    let non_member = Address::generate(&ctx.env);

    client.set_operator(&ctx.stream_id, &operator);
    client.set_operator(&ctx.stream_id, &operator);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), 1);

    // Removing a non-member does not error or alter existing operators.
    client.remove_operator(&ctx.stream_id, &non_member);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), 1);
    assert!(client.get_operators(&ctx.stream_id).contains(&operator));
}

#[test]
fn recipient_can_be_operator() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);

    client.set_operator(&ctx.stream_id, &ctx.recipient);
    ctx.env.ledger().set_timestamp(1_500);
    let paused = client.pause_as(&ctx.recipient, &ctx.stream_id);
    assert_eq!(paused.status, StreamStatus::Paused);

    ctx.env.ledger().set_timestamp(1_600);
    let resumed = client.resume_as(&ctx.recipient, &ctx.stream_id);
    assert_eq!(resumed.status, StreamStatus::Active);
}

#[test]
fn operator_list_respects_size_cap() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);

    let mut added = soroban_sdk::Vec::new(&ctx.env);
    for _ in 0..MAX_OPERATORS {
        let op = Address::generate(&ctx.env);
        client.set_operator(&ctx.stream_id, &op);
        added.push_back(op);
    }
    assert_eq!(client.get_operators(&ctx.stream_id).len(), MAX_OPERATORS);

    // Duplicate add at cap is still idempotent.
    let first = added.get(0).unwrap();
    client.set_operator(&ctx.stream_id, &first);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), MAX_OPERATORS);

    // Adding a brand new operator beyond cap fails.
    let overflow = Address::generate(&ctx.env);
    assert_eq!(
        client.try_set_operator(&ctx.stream_id, &overflow),
        Err(Ok(Error::StreamLimitExceeded))
    );

    // Removing one operator frees a slot for a new operator.
    client.remove_operator(&ctx.stream_id, &first);
    client.set_operator(&ctx.stream_id, &overflow);
    assert_eq!(client.get_operators(&ctx.stream_id).len(), MAX_OPERATORS);
    assert!(client.get_operators(&ctx.stream_id).contains(&overflow));
}

#[test]
fn operator_cannot_pause_or_resume_ended_stream() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let operator = Address::generate(&ctx.env);

    client.set_operator(&ctx.stream_id, &operator);

    // Advance past end_time and settle the stream.
    ctx.env.ledger().set_timestamp(2_500);
    client.settle(&ctx.stream_id);

    assert_eq!(
        client.try_pause_as(&operator, &ctx.stream_id),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(
        client.try_resume_as(&operator, &ctx.stream_id),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn operator_events_are_emitted() {
    let ctx = setup();
    let client = ContractClient::new(&ctx.env, &ctx.contract_id);
    let operator = Address::generate(&ctx.env);

    client.set_operator(&ctx.stream_id, &operator);
    let set_events = ctx.env.events().all();
    let last_set = set_events.last().unwrap();
    let expected_set_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &ctx.env,
        Symbol::new(&ctx.env, "stream").into_val(&ctx.env),
        Symbol::new(&ctx.env, "operator_set").into_val(&ctx.env),
    ];
    assert_eq!(last_set.1, expected_set_topic);

    client.remove_operator(&ctx.stream_id, &operator);
    let rem_events = ctx.env.events().all();
    let last_rem = rem_events.last().unwrap();
    let expected_rem_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &ctx.env,
        Symbol::new(&ctx.env, "stream").into_val(&ctx.env),
        Symbol::new(&ctx.env, "operator_removed").into_val(&ctx.env),
    ];
    assert_eq!(last_rem.1, expected_rem_topic);
}
