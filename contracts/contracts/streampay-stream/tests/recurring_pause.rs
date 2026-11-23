//! Integration tests for `pause_recurring_stream` and `resume_recurring_stream`.

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, IntoVal};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

struct TestFixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
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

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    client.initialize(&admin);

    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);
    StellarAssetClient::new(&env, &token).mint(&recipient, &0);

    TestFixture {
        env,
        admin,
        sender,
        recipient,
        token,
        contract_id,
        client,
    }
}

fn create_default_recurring(f: &TestFixture) -> u64 {
    // 5 cycles, 100s each, 1_000 tokens per cycle, starting at t = 1_000
    f.client.create_recurring_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &1_000i128,
        &100u64,
        &5u64,
        &1_000u64,
        &0u32,
    )
}

#[test]
fn pause_and_resume_happy_path_and_events() {
    let f = setup();
    let id = create_default_recurring(&f);

    // Advance 1.5 cycles (t = 1_150) and pause.
    f.env.ledger().set_timestamp(1_150);
    let paused = f.client.pause_recurring_stream(&id);
    assert_eq!(paused.status, StreamStatus::Paused);
    assert_eq!(paused.paused_at, 1_150);
    assert_eq!(paused.total_paused_duration, 0);

    // Exactly one event emitted by the pause call.
    assert_eq!(f.env.events().all().len(), 1);

    // Advance 300s while paused (t = 1_450) and resume.
    f.env.ledger().set_timestamp(1_450);
    let resumed = f.client.resume_recurring_stream(&id);
    assert_eq!(resumed.status, StreamStatus::Active);
    assert_eq!(resumed.paused_at, 0);
    assert_eq!(resumed.total_paused_duration, 300);

    // Exactly one event emitted by the resume call.
    assert_eq!(f.env.events().all().len(), 1);
}

#[test]
fn double_pause_returns_invalid_state_and_emits_no_event() {
    let f = setup();
    let id = create_default_recurring(&f);

    f.env.ledger().set_timestamp(1_100);
    f.client.pause_recurring_stream(&id);

    let err = f
        .client
        .try_pause_recurring_stream(&id)
        .expect_err("double pause must fail");
    assert_eq!(err, Ok(Error::InvalidState));
    assert_eq!(f.env.events().all().len(), 0);
}

#[test]
fn resume_without_pause_returns_invalid_state_and_emits_no_event() {
    let f = setup();
    let id = create_default_recurring(&f);

    let err = f
        .client
        .try_resume_recurring_stream(&id)
        .expect_err("resume on Active stream must fail");
    assert_eq!(err, Ok(Error::InvalidState));
    assert_eq!(f.env.events().all().len(), 0);
}

#[test]
fn unknown_id_returns_not_found() {
    let f = setup();

    let pause_err = f
        .client
        .try_pause_recurring_stream(&999u64)
        .expect_err("pause on unknown id must fail");
    assert_eq!(pause_err, Ok(Error::NotFound));

    let resume_err = f
        .client
        .try_resume_recurring_stream(&999u64)
        .expect_err("resume on unknown id must fail");
    assert_eq!(resume_err, Ok(Error::NotFound));
}

#[test]
fn wrong_signer_fails_auth_for_pause_and_resume() {
    let f = setup();
    let id = create_default_recurring(&f);
    let attacker = Address::generate(&f.env);

    // Mock auth only for `attacker`, not `sender` -> pause must fail auth.
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "pause_recurring_stream",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_pause_recurring_stream(&id).is_err());

    // Pause legitimately with sender auth.
    f.env.mock_all_auths();
    f.client.pause_recurring_stream(&id);

    // Mock auth only for `recipient`, not `sender` -> resume must fail auth.
    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "resume_recurring_stream",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_resume_recurring_stream(&id).is_err());
}

#[test]
fn vesting_frozen_across_long_pause_and_resumes_from_frozen_point() {
    let f = setup();
    let id = create_default_recurring(&f);

    // At t = 1_250: 250s elapsed -> 2 cycles vested (2_000).
    f.env.ledger().set_timestamp(1_250);
    assert_eq!(f.client.recurring_vested(&id), 2_000);

    // Pause at t = 1_250.
    f.client.pause_recurring_stream(&id);

    // Advance far into the future (10_000s later, well past all 5 cycles).
    f.env.ledger().set_timestamp(11_250);
    assert_eq!(f.client.recurring_vested(&id), 2_000);
    assert_eq!(f.client.recurring_withdrawable(&id), 2_000);

    // Resume at t = 11_250 (pause span = 10_000s).
    f.client.resume_recurring_stream(&id);

    // Immediately after resume, still 2 cycles vested (250s effective elapsed).
    assert_eq!(f.client.recurring_vested(&id), 2_000);

    // Advance 49s -> 299s effective elapsed -> still 2 cycles.
    f.env.ledger().set_timestamp(11_299);
    assert_eq!(f.client.recurring_vested(&id), 2_000);

    // Advance 1 more second -> 300s effective elapsed -> 3 cycles vested (3_000).
    f.env.ledger().set_timestamp(11_300);
    assert_eq!(f.client.recurring_vested(&id), 3_000);

    // Advance 200 more seconds -> 500s effective elapsed -> all 5 cycles vested (5_000).
    f.env.ledger().set_timestamp(11_500);
    assert_eq!(f.client.recurring_vested(&id), 5_000);
}

#[test]
fn process_and_withdraw_already_vested_cycles_while_paused() {
    let f = setup();
    let id = create_default_recurring(&f);
    let token_client = TokenClient::new(&f.env, &f.token);

    // Advance 2 cycles (t = 1_200) and pause without having processed or withdrawn yet.
    f.env.ledger().set_timestamp(1_200);
    f.client.pause_recurring_stream(&id);

    // Move time forward significantly while paused.
    f.env.ledger().set_timestamp(5_000);

    // Keeper can still process already-vested cycles while paused.
    let processed = f.client.process_recurring_stream(&id);
    assert_eq!(processed.cycles_completed, 2);
    assert_eq!(processed.status, StreamStatus::Paused);

    // Recipient can withdraw the 2 already-vested cycles (2_000).
    let withdrawn = f.client.withdraw_recurring(&id, &f.recipient, &2_000i128);
    assert_eq!(withdrawn, 2_000);
    assert_eq!(token_client.balance(&f.recipient), 2_000);
    assert_eq!(f.client.recurring_withdrawable(&id), 0);

    // Attempting to withdraw more while paused must fail with OverWithdraw.
    let over = f
        .client
        .try_withdraw_recurring(&id, &f.recipient, &1i128)
        .expect_err("over-withdraw while paused must fail");
    assert_eq!(over, Ok(Error::OverWithdraw));
}

#[test]
fn cancel_while_paused_settles_frozen_vested_and_refunds_unvested() {
    let f = setup();
    let id = create_default_recurring(&f);
    let token_client = TokenClient::new(&f.env, &f.token);

    let sender_before = token_client.balance(&f.sender);

    // Advance 2 cycles (2_000 vested) and pause at t = 1_200.
    f.env.ledger().set_timestamp(1_200);
    f.client.pause_recurring_stream(&id);

    // Advance far into the future while paused, then cancel.
    f.env.ledger().set_timestamp(9_000);
    let cancelled = f.client.cancel_recurring_stream(&id);
    assert_eq!(cancelled.status, StreamStatus::Cancelled);

    // Recipient gets the 2 frozen vested cycles (2_000); sender gets 3 unvested cycles (3_000).
    assert_eq!(token_client.balance(&f.recipient), 2_000);
    assert_eq!(token_client.balance(&f.sender), sender_before + 3_000);
}

#[test]
fn pause_on_ended_or_cancelled_returns_invalid_state() {
    let f = setup();

    // Case 1: Ended stream.
    let ended_id = create_default_recurring(&f);
    f.env.ledger().set_timestamp(2_000); // Past all 5 cycles (start 1_000 + 500 = 1_500).
    let ended = f.client.process_recurring_stream(&ended_id);
    assert_eq!(ended.status, StreamStatus::Ended);

    let err_ended = f
        .client
        .try_pause_recurring_stream(&ended_id)
        .expect_err("pause on Ended stream must fail");
    assert_eq!(err_ended, Ok(Error::InvalidState));

    // Case 2: Cancelled stream.
    let cancelled_id = create_default_recurring(&f);
    f.client.cancel_recurring_stream(&cancelled_id);

    let err_cancelled = f
        .client
        .try_pause_recurring_stream(&cancelled_id)
        .expect_err("pause on Cancelled stream must fail");
    assert_eq!(err_cancelled, Ok(Error::InvalidState));
}

#[test]
fn global_contract_pause_blocks_pause_recurring_stream() {
    let f = setup();
    let id = create_default_recurring(&f);

    f.client.set_paused(&f.admin, &true);

    let err = f
        .client
        .try_pause_recurring_stream(&id)
        .expect_err("global pause must block pause_recurring_stream");
    assert_eq!(err, Ok(Error::ContractPaused));
}
