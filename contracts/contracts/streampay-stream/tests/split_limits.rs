//! Limit, cooloff and allowlist enforcement for `create_split_stream`.
//!
//! Split streams share the per-sender active-stream counter with
//! single-recipient streams, honour the creation cooloff, and reject tokens
//! blocked by the admin allowlist — exactly like `create_stream`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{
    token::StellarAssetClient, vec, Address, Env,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

const TOTAL_AMOUNT: i128 = 1_000;
const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;

struct Fixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient_a: Address,
    recipient_b: Address,
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
    let recipient_a = Address::generate(&env);
    let recipient_b = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000);
    StellarAssetClient::new(&env, &token).mint(&recipient_a, &0);
    StellarAssetClient::new(&env, &token).mint(&recipient_b, &0);

    client.initialize(&admin);

    Fixture {
        env,
        admin,
        sender,
        recipient_a,
        recipient_b,
        token,
        client,
    }
}

fn create_split_from(f: &Fixture, start_time: u64, end_time: u64) -> u64 {
    f.client.create_split_stream(
        &f.sender,
        &f.token,
        &TOTAL_AMOUNT,
        &start_time,
        &end_time,
        &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
        &vec![&f.env, 1u64, 1u64],
    )
}

fn create_split_ok(f: &Fixture) -> u64 {
    create_split_from(f, START_TIME, END_TIME)
}

#[test]
fn create_split_stream_increments_the_sender_counter() {
    let f = setup();
    assert_eq!(f.client.sender_stream_count(&f.sender), 0);

    let id = create_split_ok(&f);

    assert_eq!(f.client.sender_stream_count(&f.sender), 1);
    assert_eq!(f.client.get_split_stream(&id).status, StreamStatus::Active);
}

#[test]
fn sender_at_the_limit_gets_stream_limit_exceeded() {
    let f = setup();
    f.client.set_max_streams_per_sender(&f.admin, &1u64);

    create_split_ok(&f);

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &TOTAL_AMOUNT,
            &START_TIME,
            &END_TIME,
            &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
            &vec![&f.env, 1u64, 1u64],
        ),
        Err(Ok(Error::StreamLimitExceeded))
    );
    assert_eq!(f.client.sender_stream_count(&f.sender), 1);
}

#[test]
fn sender_below_the_limit_may_create_more_splits() {
    let f = setup();
    f.client.set_max_streams_per_sender(&f.admin, &2u64);

    create_split_ok(&f);
    create_split_ok(&f);

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &TOTAL_AMOUNT,
            &START_TIME,
            &END_TIME,
            &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
            &vec![&f.env, 1u64, 1u64],
        ),
        Err(Ok(Error::StreamLimitExceeded))
    );
}

#[test]
fn cancelling_a_split_stream_frees_a_limit_slot() {
    let f = setup();
    f.client.set_max_streams_per_sender(&f.admin, &1u64);

    let id = create_split_ok(&f);
    f.client.cancel_split_stream(&id);

    assert_eq!(f.client.sender_stream_count(&f.sender), 0);
    create_split_ok(&f);
}

#[test]
fn settling_a_split_stream_frees_a_limit_slot() {
    let f = setup();
    f.client.set_max_streams_per_sender(&f.admin, &1u64);

    let id = create_split_ok(&f);

    f.env.ledger().set_timestamp(END_TIME);
    f.client.withdraw_split(&id, &f.recipient_a, &500i128);
    f.client.withdraw_split(&id, &f.recipient_b, &500i128);

    assert_eq!(f.client.get_split_stream(&id).status, StreamStatus::Settled);
    assert_eq!(f.client.sender_stream_count(&f.sender), 0);
    create_split_from(&f, END_TIME, END_TIME + 1_000);
}

#[test]
fn draft_and_split_streams_share_the_sender_counter() {
    let f = setup();
    f.client.set_max_streams_per_sender(&f.admin, &1u64);

    f.client
        .create_draft_stream(&f.sender, &f.recipient_a, &f.token, &TOTAL_AMOUNT, &100u64);

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &TOTAL_AMOUNT,
            &START_TIME,
            &END_TIME,
            &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
            &vec![&f.env, 1u64, 1u64],
        ),
        Err(Ok(Error::StreamLimitExceeded))
    );
}

#[test]
fn creation_cooloff_blocks_a_second_split_stream() {
    let f = setup();
    f.client.set_cooloff_duration(&f.admin, &100u64);

    create_split_ok(&f);

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &TOTAL_AMOUNT,
            &START_TIME,
            &END_TIME,
            &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
            &vec![&f.env, 1u64, 1u64],
        ),
        Err(Ok(Error::CooloffActive))
    );

    f.env.ledger().set_timestamp(START_TIME + 100);
    create_split_from(&f, START_TIME + 100, END_TIME + 100);
}

#[test]
fn blocked_tokens_are_rejected() {
    let f = setup();
    f.client.set_token_allowed(&f.admin, &f.token, &false);

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &TOTAL_AMOUNT,
            &START_TIME,
            &END_TIME,
            &vec![&f.env, f.recipient_a.clone(), f.recipient_b.clone()],
            &vec![&f.env, 1u64, 1u64],
        ),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(f.client.sender_stream_count(&f.sender), 0);
}
