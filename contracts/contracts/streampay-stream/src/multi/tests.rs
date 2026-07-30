use super::*;
use crate::Contract;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, Vec};

/// All addresses and tokens needed by a single test.
struct TestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipients: [Address; 3],
    token: Address,
}

fn setup() -> TestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let r0 = Address::generate(&env);
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Fund sender
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);
    // Establish trustlines for all recipients (mint 0)
    for r in [&r0, &r1, &r2] {
        StellarAssetClient::new(&env, &token).mint(r, &0i128);
    }

    TestData {
        env,
        admin,
        sender,
        recipients: [r0, r1, r2],
        token,
    }
}

fn to_recipients(env: &Env, addrs: &[Address; 3]) -> Vec<Address> {
    let mut v = Vec::new(env);
    for a in addrs {
        v.push_back(a.clone());
    }
    v
}

fn to_weights(env: &Env, weights: &[u64; 3]) -> Vec<u64> {
    let mut v = Vec::new(env);
    for w in weights {
        v.push_back(*w);
    }
    v
}

fn client<'a>(env: &'a Env, admin: &'a Address) -> crate::ContractClient<'a> {
    let contract_id = env.register(Contract, ());
    let client = crate::ContractClient::new(env, &contract_id);
    client.initialize(admin);
    client
}

fn create_default_split(
    env: &Env,
    client: &crate::ContractClient<'_>,
    sender: &Address,
    token: &Address,
    recipients: &[Address; 3],
) -> u64 {
    let mut rv = Vec::new(env);
    rv.push_back(recipients[0].clone());
    rv.push_back(recipients[1].clone());
    let mut wv = Vec::new(env);
    wv.push_back(6000u64);
    wv.push_back(4000u64);

    client.create_split_stream(sender, token, &1000i128, &1_100u64, &1_200u64, &rv, &wv)
}

// ── create_split_stream ─────────────────────────────────────────────────

#[test]
fn create_split_stream_basic() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let stream = client.get_split_stream(&id);
    assert_eq!(stream.sender, td.sender);
    assert_eq!(stream.token, td.token);
    assert_eq!(stream.total_amount, 1000);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(stream.total_weight, 10000);

    assert_eq!(stream.recipients.len(), 2);
    let r0 = stream.recipients.get(0).unwrap();
    assert_eq!(r0.recipient, td.recipients[0]);
    assert_eq!(r0.weight, 6000);
    assert_eq!(r0.released_amount, 0);
    let r1 = stream.recipients.get(1).unwrap();
    assert_eq!(r1.recipient, td.recipients[1]);
    assert_eq!(r1.weight, 4000);
    assert_eq!(r1.released_amount, 0);
}

#[test]
fn create_split_stream_zero_amount_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let rv = to_recipients(&td.env, &td.recipients);
    let wv = to_weights(&td.env, &[5000, 3000, 2000]);

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &0i128, &1_100u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("zero amount should fail"),
        Ok(Error::InvalidAmount)
    );
}

#[test]
fn create_split_stream_single_recipient_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let mut rv = Vec::new(&td.env);
    rv.push_back(td.recipients[0].clone());
    let mut wv = Vec::new(&td.env);
    wv.push_back(10000u64);

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("single recipient should fail"),
        Ok(Error::InvalidAmount)
    );
}

#[test]
fn create_split_stream_unequal_vecs_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let rv = to_recipients(&td.env, &td.recipients);
    let mut wv = Vec::new(&td.env);
    wv.push_back(10000u64);

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("unequal vecs should fail"),
        Ok(Error::InvalidAmount)
    );
}

#[test]
fn create_split_stream_self_recipient_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let mut rv = Vec::new(&td.env);
    rv.push_back(td.sender.clone());
    rv.push_back(td.recipients[0].clone());
    let mut wv = Vec::new(&td.env);
    wv.push_back(5000u64);
    wv.push_back(5000u64);

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("self-recipient should fail"),
        Ok(Error::SelfStream)
    );
}

#[test]
fn create_split_stream_invalid_time_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let rv = to_recipients(&td.env, &td.recipients);
    let wv = to_weights(&td.env, &[5000, 3000, 2000]);

    let result = client.try_create_split_stream(
        &td.sender,
        &td.token,
        &1000i128,
        &1_100u64,
        &1_100u64,
        &rv.clone(),
        &wv.clone(),
    );
    assert_eq!(
        result.expect_err("zero duration should fail"),
        Ok(Error::InvalidTimeRange)
    );

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &1000i128, &500u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("past start_time should fail"),
        Ok(Error::InvalidTimeRange)
    );
}

#[test]
fn create_split_stream_emits_event() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    td.env.events().all(); // clear
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let events = td.env.events().all();
    let ev = events
        .iter()
        .find(|(topics, _, _)| {
            topics.len() >= 2 && topics.get(1).unwrap() == soroban_sdk::symbol_short!("split_cr")
        })
        .expect("should find split_created event");
    let (_, _, data) = ev;
    let (ev_id, _): (u64, _) = soroban_sdk::IntoVal::into_val(&td.env, &data);
    assert_eq!(ev_id, id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn create_split_stream_requires_auth() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let rv = to_recipients(&td.env, &td.recipients);
    let wv = to_weights(&td.env, &[5000, 3000, 2000]);

    td.env.mock_auths(&[]);
    client.create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );
}

#[test]
fn create_split_stream_when_paused_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);

    client.set_paused(&td.admin, &true);

    let rv = to_recipients(&td.env, &td.recipients);
    let wv = to_weights(&td.env, &[5000, 3000, 2000]);

    let result = client.try_create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );
    assert_eq!(
        result.expect_err("paused should block creation"),
        Ok(Error::ContractPaused)
    );
}

// ── get_split_stream ────────────────────────────────────────────────────

#[test]
fn get_split_stream_not_found() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let result = client.try_get_split_stream(&9999);
    assert_eq!(
        result.expect_err("missing stream should fail"),
        Ok(Error::NotFound)
    );
}

// ── withdraw_split ─────────────────────────────────────────────────────

#[test]
fn withdraw_split_basic() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    let withdrawn = client.withdraw_split(&id, &td.recipients[0], &200i128);
    assert_eq!(withdrawn, 200);

    let stream = client.get_split_stream(&id);
    assert_eq!(stream.total_released, 200);
    let r0 = stream.recipients.get(0).unwrap();
    assert_eq!(r0.released_amount, 200);
    let r1 = stream.recipients.get(1).unwrap();
    assert_eq!(r1.released_amount, 0);
}

#[test]
fn withdraw_split_over_withdraw_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    let result = client.try_withdraw_split(&id, &td.recipients[0], &500i128);
    assert_eq!(
        result.expect_err("over-withdraw should fail"),
        Ok(Error::OverWithdraw)
    );
}

#[test]
fn withdraw_split_unauthorized_recipient_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    let result = client.try_withdraw_split(&id, &td.recipients[2], &100i128);
    assert_eq!(
        result.expect_err("unauthorized recipient should fail"),
        Ok(Error::InvalidState)
    );
}

#[test]
fn withdraw_split_zero_amount_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let result = client.try_withdraw_split(&id, &td.recipients[0], &0i128);
    assert_eq!(
        result.expect_err("zero amount should fail"),
        Ok(Error::InvalidAmount)
    );
}

#[test]
fn withdraw_split_from_settled_stream_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_300);
    client.withdraw_split(&id, &td.recipients[0], &600i128);
    client.withdraw_split(&id, &td.recipients[1], &400i128);

    let stream = client.get_split_stream(&id);
    assert_eq!(stream.status, StreamStatus::Settled);

    let result = client.try_withdraw_split(&id, &td.recipients[0], &1i128);
    assert_eq!(
        result.expect_err("settled stream should fail"),
        Ok(Error::AlreadySettled)
    );
}

#[test]
fn withdraw_split_emits_event() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    td.env.events().all(); // clear
    client.withdraw_split(&id, &td.recipients[0], &100i128);

    let events = td.env.events().all();
    let ev = events
        .iter()
        .find(|(topics, _, _)| {
            topics.len() >= 2 && topics.get(1).unwrap() == soroban_sdk::symbol_short!("split_wd")
        })
        .expect("should find split_withdrawn event");
    let (_, _, data) = ev;
    let (ev_id, _): (u64, _) = soroban_sdk::IntoVal::into_val(&td.env, &data);
    assert_eq!(ev_id, id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn withdraw_split_requires_auth() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    td.env.mock_auths(&[]);
    client.withdraw_split(&id, &td.recipients[0], &100i128);
}

// ── cancel_split_stream ─────────────────────────────────────────────────

#[test]
fn cancel_split_stream_basic() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let tkn = soroban_sdk::token::Client::new(&td.env, &td.token);
    let sender_before = tkn.balance(&td.sender);
    let r1_before = tkn.balance(&td.recipients[0]);
    let r2_before = tkn.balance(&td.recipients[1]);

    td.env.ledger().set_timestamp(1_150);
    client.cancel_split_stream(&id);

    assert_eq!(tkn.balance(&td.recipients[0]), r1_before + 300);
    assert_eq!(tkn.balance(&td.recipients[1]), r2_before + 200);
    assert_eq!(tkn.balance(&td.sender), sender_before + 500);

    let stream = client.get_split_stream(&id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

#[test]
fn cancel_split_stream_already_settled_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_300);
    client.withdraw_split(&id, &td.recipients[0], &600i128);
    client.withdraw_split(&id, &td.recipients[1], &400i128);

    let result = client.try_cancel_split_stream(&id);
    assert_eq!(
        result.expect_err("settled cancel should fail"),
        Ok(Error::InvalidState)
    );
}

#[test]
fn cancel_split_stream_already_cancelled_fails() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    client.cancel_split_stream(&id);
    let result = client.try_cancel_split_stream(&id);
    assert_eq!(
        result.expect_err("double cancel should fail"),
        Ok(Error::InvalidState)
    );
}

#[test]
fn cancel_split_stream_with_partial_withdrawals() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let tkn = soroban_sdk::token::Client::new(&td.env, &td.token);

    td.env.ledger().set_timestamp(1_150);
    client.withdraw_split(&id, &td.recipients[0], &100i128);

    let sender_before = tkn.balance(&td.sender);
    let r1_before = tkn.balance(&td.recipients[0]);
    let r2_before = tkn.balance(&td.recipients[1]);

    client.cancel_split_stream(&id);

    assert_eq!(tkn.balance(&td.sender), sender_before + 500);
    assert_eq!(tkn.balance(&td.recipients[0]), r1_before + 200);
    assert_eq!(tkn.balance(&td.recipients[1]), r2_before + 200);
}

#[test]
fn cancel_split_stream_after_end_pays_all() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let tkn = soroban_sdk::token::Client::new(&td.env, &td.token);
    let sender_before = tkn.balance(&td.sender);
    let r1_before = tkn.balance(&td.recipients[0]);
    let r2_before = tkn.balance(&td.recipients[1]);

    td.env.ledger().set_timestamp(1_300);
    client.cancel_split_stream(&id);

    assert_eq!(tkn.balance(&td.recipients[0]), r1_before + 600);
    assert_eq!(tkn.balance(&td.recipients[1]), r2_before + 400);
    assert_eq!(tkn.balance(&td.sender), sender_before);
}

#[test]
fn cancel_split_stream_before_start_returns_all() {
    let td = setup();
    let client = client(&td.env, &td.admin);

    let mut rv = Vec::new(&td.env);
    rv.push_back(td.recipients[0].clone());
    rv.push_back(td.recipients[1].clone());
    let mut wv = Vec::new(&td.env);
    wv.push_back(5000u64);
    wv.push_back(5000u64);
    let id = client.create_split_stream(
        &td.sender, &td.token, &1000i128, &2_000u64, &3_000u64, &rv, &wv,
    );

    let tkn = soroban_sdk::token::Client::new(&td.env, &td.token);
    let sender_before = tkn.balance(&td.sender);

    client.cancel_split_stream(&id);

    assert_eq!(tkn.balance(&td.sender), sender_before + 1000);
    assert_eq!(tkn.balance(&td.recipients[0]), 0);
    assert_eq!(tkn.balance(&td.recipients[1]), 0);
}

#[test]
fn cancel_split_stream_emits_event() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_150);
    td.env.events().all(); // clear
    client.cancel_split_stream(&id);

    let events = td.env.events().all();
    let ev = events
        .iter()
        .find(|(topics, _, _)| {
            topics.len() >= 2 && topics.get(1).unwrap() == soroban_sdk::symbol_short!("split_ca")
        })
        .expect("should find split_cancelled event");
    let (_, _, data) = ev;
    let (ev_id, _): (u64, _) = soroban_sdk::IntoVal::into_val(&td.env, &data);
    assert_eq!(ev_id, id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn cancel_split_stream_requires_auth() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.mock_auths(&[]);
    client.cancel_split_stream(&id);
}

// ── split_withdrawable / split_stream_balance ───────────────────────────

#[test]
fn split_withdrawable_basic() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    assert_eq!(client.split_withdrawable(&id, &td.recipients[0]), Ok(0));

    td.env.ledger().set_timestamp(1_150);
    assert_eq!(client.split_withdrawable(&id, &td.recipients[0]), Ok(300));
    assert_eq!(client.split_withdrawable(&id, &td.recipients[1]), Ok(200));

    client.withdraw_split(&id, &td.recipients[0], &100i128);
    assert_eq!(client.split_withdrawable(&id, &td.recipients[0]), Ok(200));

    td.env.ledger().set_timestamp(1_300);
    assert_eq!(client.split_withdrawable(&id, &td.recipients[0]), Ok(500));
}

#[test]
fn split_withdrawable_missing_recipient() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    let result = client.try_split_withdrawable(&id, &td.recipients[2]);
    assert_eq!(
        result.expect_err("missing recipient should fail"),
        Ok(Error::NotFound)
    );
}

#[test]
fn split_withdrawable_missing_stream() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let result = client.try_split_withdrawable(&9999, &td.recipients[0]);
    assert_eq!(
        result.expect_err("missing stream should fail"),
        Ok(Error::NotFound)
    );
}

#[test]
fn split_stream_balance_basic() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    assert_eq!(client.split_stream_balance(&id), Ok(0));

    td.env.ledger().set_timestamp(1_150);
    assert_eq!(client.split_stream_balance(&id), Ok(500));

    td.env.ledger().set_timestamp(1_300);
    assert_eq!(client.split_stream_balance(&id), Ok(1000));
}

#[test]
fn split_stream_balance_not_found() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let result = client.try_split_stream_balance(&9999);
    assert_eq!(
        result.expect_err("missing stream should fail"),
        Ok(Error::NotFound)
    );
}

// ── Three recipients with varying weights ──────────────────────────────

#[test]
fn three_recipients_correct_proportions() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let rv = to_recipients(&td.env, &td.recipients);
    let wv = to_weights(&td.env, &[5000, 3000, 2000]);
    let id = client.create_split_stream(
        &td.sender, &td.token, &1000i128, &1_100u64, &1_200u64, &rv, &wv,
    );

    td.env.ledger().set_timestamp(1_150);

    assert_eq!(client.split_withdrawable(&id, &td.recipients[0]), Ok(250));
    assert_eq!(client.split_withdrawable(&id, &td.recipients[1]), Ok(150));
    assert_eq!(client.split_withdrawable(&id, &td.recipients[2]), Ok(100));
}

// ── No events on failure ───────────────────────────────────────────────

#[test]
fn no_events_on_withdraw_failure() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.events().all(); // clear
    let _ = client.try_withdraw_split(&id, &td.recipients[0], &9999i128);

    let events = td.env.events().all();
    assert!(events.is_empty(), "failed withdraw should not emit events");
}

#[test]
fn no_events_on_cancel_failure() {
    let td = setup();
    let client = client(&td.env, &td.admin);
    let id = create_default_split(&td.env, &client, &td.sender, &td.token, &td.recipients);

    td.env.ledger().set_timestamp(1_300);
    client.withdraw_split(&id, &td.recipients[0], &600i128);
    client.withdraw_split(&id, &td.recipients[1], &400i128);

    td.env.events().all(); // clear
    let _ = client.try_cancel_split_stream(&id);

    let events = td.env.events().all();
    assert!(events.is_empty(), "failed cancel should not emit events");
}
