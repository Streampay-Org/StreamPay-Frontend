//! Pause/resume tests for multi-recipient split streams.
//!
//! `pause_split_stream` freezes accrual for every recipient at the pause
//! timestamp; `resume_split_stream` continues accrual and extends `end_time`
//! by the paused span so the unstreamed time is preserved.

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{
    symbol_short, token::Client as TokenClient, token::StellarAssetClient, vec, Address, Env,
    Symbol, TryFromVal,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

const TOTAL_AMOUNT: i128 = 1_000;
const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;

struct SplitTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient_a: Address,
    recipient_b: Address,
    token: Address,
    client: ContractClient<'static>,
}

fn setup() -> SplitTestData {
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

    SplitTestData {
        env,
        admin,
        sender,
        recipient_a,
        recipient_b,
        token,
        client,
    }
}

fn create_split(data: &SplitTestData) -> u64 {
    data.client.create_split_stream(
        &data.sender,
        &data.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &vec![
            &data.env,
            data.recipient_a.clone(),
            data.recipient_b.clone(),
        ],
        &vec![&data.env, 1u64, 1u64],
    )
}

fn balance(data: &SplitTestData, who: &Address) -> i128 {
    TokenClient::new(&data.env, &data.token).balance(who)
}

#[test]
fn pause_freezes_withdrawable_for_every_recipient() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_a), 250);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_b), 250);

    let paused = data.client.pause_split_stream(&id);
    assert_eq!(paused.status, StreamStatus::Paused);
    assert_eq!(paused.pause_time, 1_500);
    assert_eq!(paused.last_update, 1_500);

    data.env.ledger().set_timestamp(1_900);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_a), 250);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_b), 250);
    assert_eq!(data.client.split_stream_balance(&id), 500);
}

#[test]
fn paused_stream_allows_only_the_frozen_amount() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);
    data.env.ledger().set_timestamp(1_900);

    assert_eq!(
        data.client.withdraw_split(&id, &data.recipient_a, &250),
        250
    );
    assert_eq!(balance(&data, &data.recipient_a), 250);

    let result = data.client.try_withdraw_split(&id, &data.recipient_a, &1);
    let err = result.expect_err("withdrawing beyond the frozen amount should fail");
    assert_eq!(err, Ok(Error::OverWithdraw));
}

#[test]
fn resume_extends_end_time_and_accrual_continues() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);

    data.env.ledger().set_timestamp(1_800);
    let resumed = data.client.resume_split_stream(&id);
    assert_eq!(resumed.status, StreamStatus::Active);
    assert_eq!(resumed.end_time, END_TIME + 300);
    assert_eq!(resumed.total_paused_duration, 300);
    assert_eq!(resumed.pause_time, 0);

    // 2 000 - 1 000 - 300 = 700 elapsed of the 1 000-unit duration.
    data.env.ledger().set_timestamp(2_000);
    assert_eq!(data.client.split_stream_balance(&id), 700);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_a), 350);

    // At the extended end time the whole amount has vested.
    data.env.ledger().set_timestamp(2_300);
    assert_eq!(data.client.split_stream_balance(&id), TOTAL_AMOUNT);
    assert_eq!(data.client.split_withdrawable(&id, &data.recipient_b), 500);
}

#[test]
fn pause_twice_returns_invalid_state() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);

    let result = data.client.try_pause_split_stream(&id);
    let err = result.expect_err("pausing a paused stream should fail");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn resume_when_active_returns_invalid_state() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    let result = data.client.try_resume_split_stream(&id);
    let err = result.expect_err("resuming an active stream should fail");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn pause_on_cancelled_stream_returns_invalid_state() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.cancel_split_stream(&id);

    let result = data.client.try_pause_split_stream(&id);
    let err = result.expect_err("pausing a cancelled stream should fail");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn pause_on_settled_stream_returns_invalid_state() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(END_TIME);
    data.client
        .withdraw_split(&id, &data.recipient_a, &(TOTAL_AMOUNT / 2));
    data.client
        .withdraw_split(&id, &data.recipient_b, &(TOTAL_AMOUNT / 2));
    assert_eq!(
        data.client.get_split_stream(&id).status,
        StreamStatus::Settled
    );

    let result = data.client.try_pause_split_stream(&id);
    let err = result.expect_err("pausing a settled stream should fail");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn multiple_pause_cycles_accumulate_paused_duration() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_200);
    data.client.pause_split_stream(&id);
    data.env.ledger().set_timestamp(1_300);
    data.client.resume_split_stream(&id);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);
    data.env.ledger().set_timestamp(1_700);
    let resumed = data.client.resume_split_stream(&id);

    assert_eq!(resumed.total_paused_duration, 300);
    assert_eq!(resumed.end_time, END_TIME + 300);

    data.env.ledger().set_timestamp(2_300);
    assert_eq!(data.client.split_stream_balance(&id), TOTAL_AMOUNT);
}

#[test]
fn cancel_while_paused_pays_only_the_frozen_share() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);

    data.env.ledger().set_timestamp(1_900);
    data.client.cancel_split_stream(&id);

    assert_eq!(balance(&data, &data.recipient_a), 250);
    assert_eq!(balance(&data, &data.recipient_b), 250);
    assert_eq!(balance(&data, &data.sender), 1_000_000 - TOTAL_AMOUNT + 500);

    let cancelled = data.client.get_split_stream(&id);
    assert_eq!(cancelled.status, StreamStatus::Cancelled);
    assert_eq!(cancelled.total_released, 500);
}

#[test]
fn contract_wide_pause_blocks_split_pause_and_resume() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.set_paused(&data.admin, &true);

    let pause_result = data.client.try_pause_split_stream(&id);
    let pause_err = pause_result.expect_err("global pause should block pausing");
    assert_eq!(pause_err, Ok(Error::ContractPaused));

    data.client.set_paused(&data.admin, &false);
    data.client.pause_split_stream(&id);
    data.client.set_paused(&data.admin, &true);

    let resume_result = data.client.try_resume_split_stream(&id);
    let resume_err = resume_result.expect_err("global pause should block resuming");
    assert_eq!(resume_err, Ok(Error::ContractPaused));
}

#[test]
fn pause_and_resume_emit_documented_events() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);

    let after_pause = data.env.events().all();
    assert_eq!(after_pause.len(), 1, "pause should emit exactly one event");
    let (_, topics, payload) = after_pause.last().expect("pause event missing");
    let topic0 = Symbol::try_from_val(&data.env, &topics.get_unchecked(0))
        .expect("topic 0 should be a symbol");
    assert_eq!(topic0, symbol_short!("stream"));
    let topic1 = Symbol::try_from_val(&data.env, &topics.get_unchecked(1))
        .expect("topic 1 should be a symbol");
    assert_eq!(topic1, Symbol::new(&data.env, "split_pa"));
    let fields = soroban_sdk::Vec::<soroban_sdk::Val>::try_from_val(&data.env, &payload)
        .expect("payload should be a vec");
    assert_eq!(fields.len(), 4);
    let paused_at =
        u64::try_from_val(&data.env, &fields.get_unchecked(2)).expect("paused_at should be u64");
    assert_eq!(paused_at, 1_500);

    data.env.ledger().set_timestamp(1_800);
    data.client.resume_split_stream(&id);

    let after_resume = data.env.events().all();
    let (_, topics, payload) = after_resume.last().expect("resume event missing");
    let topic1 = Symbol::try_from_val(&data.env, &topics.get_unchecked(1))
        .expect("topic 1 should be a symbol");
    assert_eq!(topic1, Symbol::new(&data.env, "split_re"));
    let fields = soroban_sdk::Vec::<soroban_sdk::Val>::try_from_val(&data.env, &payload)
        .expect("payload should be a vec");
    assert_eq!(fields.len(), 4);
    let end_time =
        u64::try_from_val(&data.env, &fields.get_unchecked(2)).expect("end_time should be u64");
    assert_eq!(end_time, END_TIME + 300);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn non_sender_cannot_pause_a_split_stream() {
    let data = setup();
    let id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.env.mock_auths(&[]);
    data.client.pause_split_stream(&id);
}
