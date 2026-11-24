#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{
    token::Client as TokenClient, token::StellarAssetClient, vec, Address, Env, Symbol,
    TryFromVal,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;
const TOTAL_AMOUNT: i128 = 1_000;

struct TestData {
    env: Env,
    sender: Address,
    recipients: [Address; 2],
    token: Address,
    contract_id: Address,
    client: ContractClient<'static>,
}

fn setup() -> TestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIME);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipients = [Address::generate(&env), Address::generate(&env)];
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000);
    for recipient in &recipients {
        StellarAssetClient::new(&env, &token).mint(recipient, &0);
    }

    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };
    client.initialize(&admin);

    TestData {
        env,
        sender,
        recipients,
        token,
        contract_id,
        client,
    }
}

fn create_split(data: &TestData) -> u64 {
    data.client.create_split_stream(
        &data.sender,
        &data.token,
        &TOTAL_AMOUNT,
        &START_TIME,
        &END_TIME,
        &vec![
            &data.env,
            data.recipients[0].clone(),
            data.recipients[1].clone(),
        ],
        &vec![&data.env, 1u64, 1u64],
    )
}

fn balance(data: &TestData, address: &Address) -> i128 {
    TokenClient::new(&data.env, &data.token).balance(address)
}

#[test]
fn amend_tops_up_and_updates_split_weights() {
    let data = setup();
    let id = create_split(&data);
    let contract_balance = balance(&data, &data.contract_id);

    data.env.ledger().set_timestamp(1_500);
    let amended = data.client.amend_split_stream(
        &id,
        &500,
        &Some(vec![&data.env, 2u64, 1u64]),
        &Some(2_500u64),
    );

    assert_eq!(amended.total_amount, TOTAL_AMOUNT + 500);
    assert_eq!(amended.total_weight, 3);
    assert_eq!(amended.duration, 1_500);
    assert_eq!(amended.recipients.get(0).unwrap().weight, 2);
    assert_eq!(balance(&data, &data.contract_id), contract_balance + 500);
    assert_eq!(balance(&data, &data.sender), 10_000 - TOTAL_AMOUNT - 500);

    let (_, topics, _) = data.env.events().all().last().unwrap();
    assert_eq!(
        Symbol::try_from_val(&data.env, &topics.get_unchecked(1)).unwrap(),
        Symbol::new(&data.env, "split_am")
    );
}

#[test]
fn zero_top_up_is_allowed_and_paused_stream_can_be_amended() {
    let data = setup();
    let id = create_split(&data);
    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&id);

    let amended = data
        .client
        .amend_split_stream(&id, &0, &None, &Some(2_500u64));

    assert_eq!(amended.status, StreamStatus::Paused);
    assert_eq!(amended.end_time, 2_500);
    assert_eq!(amended.total_amount, TOTAL_AMOUNT);
    assert_eq!(balance(&data, &data.contract_id), TOTAL_AMOUNT);
}

#[test]
fn reducing_weight_below_released_amount_is_rejected() {
    let data = setup();
    let id = create_split(&data);
    data.env.ledger().set_timestamp(1_500);
    data.client
        .withdraw_split(&id, &data.recipients[0], &250);

    let result = data.client.try_amend_split_stream(
        &id,
        &0,
        &Some(vec![&data.env, 1u64, 3u64]),
        &None,
    );
    assert_eq!(
        result.expect_err("weight change would claw back released tokens"),
        Ok(Error::InvalidAmount)
    );
    assert_eq!(data.client.get_split_stream(&id).total_weight, 2);
}

#[test]
fn invalid_and_overflowing_weights_are_rejected() {
    let data = setup();
    let id = create_split(&data);

    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &0, &Some(vec![&data.env, 1u64]), &None)
            .expect_err("weights length must match recipients"),
        Ok(Error::InvalidAmount)
    );
    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &0, &Some(vec![&data.env, 0u64, 1u64]), &None)
            .expect_err("weights must be positive"),
        Ok(Error::InvalidAmount)
    );
    assert_eq!(
        data.client
            .try_amend_split_stream(
                &id,
                &0,
                &Some(vec![&data.env, u64::MAX, 1u64]),
                &None,
            )
            .expect_err("total weight overflow must fail"),
        Ok(Error::Overflow)
    );
}

#[test]
fn invalid_top_up_end_time_and_terminal_state_are_rejected() {
    let data = setup();
    let id = create_split(&data);

    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &-1, &None, &None)
            .expect_err("negative top-up must fail"),
        Ok(Error::InvalidAmount)
    );
    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &0, &None, &Some(1_500u64))
            .expect_err("end time must be in the future"),
        Ok(Error::InvalidTimeRange)
    );

    data.env.ledger().set_timestamp(END_TIME);
    data.client
        .withdraw_split(&id, &data.recipients[0], &500);
    data.client
        .withdraw_split(&id, &data.recipients[1], &500);
    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &0, &None, &None)
            .expect_err("settled streams cannot be amended"),
        Ok(Error::InvalidState)
    );
}

#[test]
fn top_up_overflow_is_rejected() {
    let data = setup();
    let id = create_split(&data);
    assert_eq!(
        data.client
            .try_amend_split_stream(&id, &i128::MAX, &None, &None)
            .expect_err("top-up amount addition must be checked"),
        Ok(Error::Overflow)
    );
}
