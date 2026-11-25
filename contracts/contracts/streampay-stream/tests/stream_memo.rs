//! Integration tests for the optional stream memo (`create_stream_with_memo`).
//!
//! The memo is a bounded (<= 64 byte) opaque payload stored alongside the
//! stream so indexers and the backend can correlate a stream with an
//! off-chain reference such as an invoice id.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{
    token::Client as TokenClient, token::StellarAssetClient, Address, Bytes, Env, Symbol,
    TryFromVal, Val,
};
use streampay_stream::{Contract, ContractClient, Error};

const TOTAL_AMOUNT: i128 = 1_000;
const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;

struct Fixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
    client: ContractClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIME);

    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000);
    StellarAssetClient::new(&env, &token).mint(&recipient, &0);

    client.initialize(&admin);

    Fixture {
        env,
        admin,
        sender,
        recipient,
        token,
        client,
    }
}

fn memo_of_len(env: &Env, len: u32) -> Bytes {
    let mut bytes = Bytes::new(env);
    for i in 0..len {
        bytes.push_back((i % 251) as u8);
    }
    bytes
}

/// Decodes the symbol at `index` of an event's topic list, if present.
fn topic_symbol(env: &Env, topics: &soroban_sdk::Vec<Val>, index: u32) -> Option<Symbol> {
    topics
        .get(index)
        .and_then(|value| Symbol::try_from_val(env, &value).ok())
}

#[test]
fn memo_roundtrips_through_get_stream_memo() {
    let f = setup();
    let memo = Bytes::from_slice(&f.env, b"invoice-2026-0042");
    let id = f.client.create_stream_with_memo(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
        &memo,
    );

    assert_eq!(f.client.get_stream_memo(&id), Some(memo));
}

#[test]
fn memo_at_the_64_byte_limit_is_accepted() {
    let f = setup();
    let memo = memo_of_len(&f.env, 64);
    let id = f.client.create_stream_with_memo(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
        &memo,
    );

    let stored = f.client.get_stream_memo(&id).expect("memo must be stored");
    assert_eq!(stored.len(), 64);
    assert_eq!(stored, memo);
}

#[test]
fn empty_memo_is_stored_as_an_empty_value() {
    let f = setup();
    let id = f.client.create_stream_with_memo(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
        &Bytes::new(&f.env),
    );

    let stored = f.client.get_stream_memo(&id).expect("memo entry exists");
    assert_eq!(stored.len(), 0);
}

#[test]
fn memo_longer_than_64_bytes_is_rejected_before_any_transfer() {
    let f = setup();
    let memo = memo_of_len(&f.env, 65);
    let balance_before = TokenClient::new(&f.env, &f.token).balance(&f.sender);

    let result = f.client.try_create_stream_with_memo(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
        &memo,
    );

    assert_eq!(result, Err(Ok(Error::MemoTooLong)));
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.sender),
        balance_before,
        "a rejected memo must not move funds"
    );
    assert_eq!(
        f.client.sender_stream_count(&f.sender),
        0,
        "no stream may be created for a rejected memo"
    );
}

#[test]
fn streams_without_a_memo_report_none() {
    let f = setup();
    let id = f.client.create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
    );

    assert_eq!(f.client.get_stream_memo(&id), None);
}

#[test]
fn draft_streams_have_no_memo() {
    let f = setup();
    let id = f
        .client
        .create_draft_stream(&f.sender, &f.recipient, &f.token, &TOTAL_AMOUNT, &100u64);

    assert_eq!(f.client.get_stream_memo(&id), None);
}

#[test]
fn unknown_stream_memo_lookup_returns_not_found() {
    let f = setup();

    assert_eq!(f.client.try_get_stream_memo(&99u64), Err(Ok(Error::NotFound)));
}

#[test]
fn memo_is_indexable_from_the_created_memo_event() {
    let f = setup();
    let memo = Bytes::from_slice(&f.env, b"ref-abc");
    let id = f.client.create_stream_with_memo(
        &f.sender,
        &f.recipient,
        &f.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &0u32,
        &memo,
    );

    let events = f.env.events().all();
    let stream_topic = Symbol::new(&f.env, "stream");
    let created_memo_topic = Symbol::new(&f.env, "created_memo");

    let memo_events: std::vec::Vec<_> = events
        .iter()
        .filter(|event| {
            topic_symbol(&f.env, &event.1, 0) == Some(stream_topic.clone())
                && topic_symbol(&f.env, &event.1, 1) == Some(created_memo_topic.clone())
        })
        .collect();

    assert_eq!(memo_events.len(), 1, "exactly one created_memo event");

    let data = &memo_events[0].2;
    let payload = soroban_sdk::Vec::<Val>::try_from_val(&f.env, data).expect("vec payload");
    assert_eq!(
        u64::try_from_val(&f.env, &payload.get(0).unwrap()).unwrap(),
        id
    );
    assert_eq!(
        Bytes::try_from_val(&f.env, &payload.get(1).unwrap()).unwrap(),
        memo
    );
}
