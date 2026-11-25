//! Integration tests for the admin-configurable minimum stream duration and
//! amount (`set_min_stream_params` / `get_min_stream_params`).
//!
//! A minimum of `0` disables the corresponding check. Streams below either
//! minimum are rejected before any token transfer.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{
    token::Client as TokenClient, token::StellarAssetClient, vec, Address, Env,
};
use streampay_stream::{Contract, ContractClient, Error};

const START_TIME: u64 = 1_000;

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

fn sender_balance(f: &Fixture) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(&f.sender)
}

#[test]
fn defaults_are_zero_and_disable_both_checks() {
    let f = setup();
    assert_eq!(f.client.get_min_stream_params(), (0u64, 0i128));

    // A one-second, one-stroop stream is fine while the minima are disabled.
    let id = f.client.create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1i128,
        &START_TIME,
        &(START_TIME + 1),
        &0u32,
    );
    assert_eq!(f.client.get_stream(&id).total_amount, 1);
}

#[test]
fn get_min_stream_params_reflects_updates() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &600u64, &500i128);

    assert_eq!(f.client.get_min_stream_params(), (600u64, 500i128));
}

#[test]
fn duration_below_minimum_is_rejected_before_transfer() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &600u64, &0i128);

    let balance_before = sender_balance(&f);
    let result = f.client.try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000i128,
        &START_TIME,
        &(START_TIME + 599),
        &0u32,
    );

    assert_eq!(result, Err(Ok(Error::InvalidDuration)));
    assert_eq!(sender_balance(&f), balance_before);
    assert_eq!(f.client.sender_stream_count(&f.sender), 0);
}

#[test]
fn amount_below_minimum_is_rejected_before_transfer() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &0u64, &500i128);

    let balance_before = sender_balance(&f);
    let result = f.client.try_create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &499i128,
        &START_TIME,
        &(START_TIME + 1_000),
        &0u32,
    );

    assert_eq!(result, Err(Ok(Error::AmountTooSmall)));
    assert_eq!(sender_balance(&f), balance_before);
}

#[test]
fn values_at_the_minimum_are_accepted() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &600u64, &500i128);

    let id = f.client.create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &500i128,
        &START_TIME,
        &(START_TIME + 600),
        &0u32,
    );

    let stream = f.client.get_stream(&id);
    assert_eq!(stream.total_amount, 500);
    assert_eq!(stream.duration, 600);
}

#[test]
fn draft_streams_enforce_both_minima() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &600u64, &500i128);

    assert_eq!(
        f.client.try_create_draft_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &500i128,
            &599u64
        ),
        Err(Ok(Error::InvalidDuration))
    );
    assert_eq!(
        f.client.try_create_draft_stream(
            &f.sender,
            &f.recipient,
            &f.token,
            &499i128,
            &600u64
        ),
        Err(Ok(Error::AmountTooSmall))
    );

    let id = f
        .client
        .create_draft_stream(&f.sender, &f.recipient, &f.token, &500i128, &600u64);
    assert_eq!(f.client.get_stream(&id).duration, 600);
}

#[test]
fn split_streams_enforce_both_minima() {
    let f = setup();
    f.client.set_min_stream_params(&f.admin, &600u64, &500i128);
    let recipient_b = Address::generate(&f.env);
    let recipients = vec![&f.env, f.recipient.clone(), recipient_b];
    let weights = vec![&f.env, 1u64, 1u64];

    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &1_000i128,
            &START_TIME,
            &(START_TIME + 599),
            &recipients,
            &weights,
        ),
        Err(Ok(Error::InvalidDuration))
    );
    assert_eq!(
        f.client.try_create_split_stream(
            &f.sender,
            &f.token,
            &499i128,
            &START_TIME,
            &(START_TIME + 600),
            &recipients,
            &weights,
        ),
        Err(Ok(Error::AmountTooSmall))
    );

    let id = f.client.create_split_stream(
        &f.sender,
        &f.token,
        &500i128,
        &START_TIME,
        &(START_TIME + 600),
        &recipients,
        &weights,
    );
    assert_eq!(f.client.get_split_stream(&id).total_amount, 500);
}

#[test]
fn only_the_admin_can_set_the_minima() {
    let f = setup();
    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client.try_set_min_stream_params(&stranger, &600u64, &500i128),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(f.client.get_min_stream_params(), (0u64, 0i128));
}
