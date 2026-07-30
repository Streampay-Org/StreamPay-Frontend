use super::*;
use crate::Contract;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{token, Address, Env, IntoVal, Symbol};

// ── Test helpers ──────────────────────────────────────────────────────

fn init_and_settle_contract(env: &Env) -> (Address, Address, Address) {
    let admin = Address::generate(env);
    let sender = Address::generate(env);
    let recipient = Address::generate(env);

    let contract_id = env.register_contract(None, Contract);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(env, &token_id);
    token.mint(&sender, &i128::from(u64::MAX));

    let client = crate::ContractClient::new(env, &contract_id);
    client.initialize(&admin);

    (sender, recipient, token_id)
}

fn create_default(env: &Env, sender: &Address, recipient: &Address, token: &Address) -> u64 {
    let now = env.ledger().timestamp();
    create(
        env.clone(),
        sender.clone(),
        recipient.clone(),
        token.clone(),
        100,       // amount_per_cycle
        1000,      // cycle_duration
        10,        // total_cycles
        now + 100, // start_time
        0,         // fee_bps
    )
    .unwrap()
}

// ── Create tests ──────────────────────────────────────────────────────

#[test]
fn test_create_recurring_stream_success() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let id = create(
        env.clone(),
        sender.clone(),
        recipient.clone(),
        token_id.clone(),
        100,
        1000,
        10,
        1_100,
        0,
    )
    .unwrap();
    assert_eq!(id, 1);

    let stream = get_existing(&env, id).unwrap();
    assert_eq!(stream.id, 1);
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.token, token_id);
    assert_eq!(stream.amount_per_cycle, 100);
    assert_eq!(stream.cycle_duration, 1000);
    assert_eq!(stream.total_cycles, 10);
    assert_eq!(stream.cycles_completed, 0);
    assert_eq!(stream.withdrawn_amount, 0);
    assert_eq!(stream.status, StreamStatus::Active);
    assert_eq!(stream.fee_bps, 0);
}

#[test]
fn test_create_recurring_stream_zero_amount_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        0,
        1000,
        10,
        1_100,
        0,
    );
    assert_eq!(result, Err(Error::InvalidAmount));
}

#[test]
fn test_create_recurring_stream_zero_cycles_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        100,
        1000,
        0,
        1_100,
        0,
    );
    assert_eq!(result, Err(Error::InvalidAmount));
}

#[test]
fn test_create_recurring_stream_zero_duration_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        100,
        0,
        10,
        1_100,
        0,
    );
    assert_eq!(result, Err(Error::InvalidTimeRange));
}

#[test]
fn test_create_recurring_stream_self_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, _, _) = init_and_settle_contract(&env);
    let token_id = Address::generate(&env);

    let result = create(
        env.clone(),
        sender.clone(),
        sender,
        token_id,
        100,
        1000,
        10,
        1_100,
        0,
    );
    assert_eq!(result, Err(Error::SelfStream));
}

#[test]
fn test_create_recurring_stream_past_start_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        100,
        1000,
        10,
        500,
        0,
    );
    assert_eq!(result, Err(Error::InvalidTimeRange));
}

#[test]
fn test_create_recurring_stream_invalid_fee_bps_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        100,
        1000,
        10,
        1_100,
        10_001,
    );
    assert_eq!(result, Err(Error::InvalidFeeBps));
}

#[test]
fn test_create_recurring_stream_overflow_escrow_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let large_amount = i128::MAX / 2 + 1;
    let result = create(
        env.clone(),
        sender,
        recipient,
        token_id,
        large_amount,
        1000,
        2,
        1_100,
        0,
    );
    assert_eq!(result, Err(Error::Overflow));
}

#[test]
fn test_create_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let _id = create(
        env.clone(),
        sender.clone(),
        recipient.clone(),
        token_id.clone(),
        100,
        1000,
        10,
        1_100,
        0,
    )
    .unwrap();

    let events = env.events().all();
    assert!(!events.is_empty());

    let created_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let topics = e.0.clone();
            topics.get(0) == Some(Symbol::new(&env, "recurring").into_val(&env))
                && topics.get(1) == Some(Symbol::new(&env, "created").into_val(&env))
        })
        .collect();
    assert_eq!(created_events.len(), 1);
}

// ── Process tests ─────────────────────────────────────────────────────

#[test]
fn test_process_advances_cycles() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 3 * 1000); // 4100
    let stream = process(env.clone(), id).unwrap();
    assert_eq!(stream.cycles_completed, 3);
    assert_eq!(stream.status, StreamStatus::Active);
}

#[test]
fn test_process_all_cycles_ends_stream() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 10 * 1000 + 1); // 11101
    let stream = process(env.clone(), id).unwrap();
    assert_eq!(stream.cycles_completed, 10);
    assert_eq!(stream.status, StreamStatus::Ended);
}

#[test]
fn test_process_before_first_cycle() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100);
    let stream = process(env.clone(), id).unwrap();
    assert_eq!(stream.cycles_completed, 0);
    assert_eq!(stream.status, StreamStatus::Active);
}

#[test]
fn test_process_nonexistent_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let result = process(env.clone(), 999);
    assert_eq!(result, Err(Error::NotFound));
}

#[test]
fn test_process_ended_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 10 * 1000 + 1);
    process(env.clone(), id).unwrap();

    let result = process(env.clone(), id);
    assert_eq!(result, Err(Error::InvalidState));
}

#[test]
fn test_process_cancelled_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    cancel(env.clone(), id).unwrap();
    let result = process(env.clone(), id);
    assert_eq!(result, Err(Error::InvalidState));
}

#[test]
fn test_process_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 2 * 1000);
    process(env.clone(), id).unwrap();

    let events = env.events().all();
    let processed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let topics = e.0.clone();
            topics.get(0) == Some(Symbol::new(&env, "recurring").into_val(&env))
                && topics.get(1) == Some(Symbol::new(&env, "processed").into_val(&env))
        })
        .collect();
    assert_eq!(processed_events.len(), 1);
}

// ── Withdraw tests ────────────────────────────────────────────────────

#[test]
fn test_withdraw_basic() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 5 * 1000);
    process(env.clone(), id).unwrap();

    let withdrawn = withdraw(env.clone(), id, recipient.clone(), 300).unwrap();
    assert_eq!(withdrawn, 300);

    let stream = get_existing(&env, id).unwrap();
    assert_eq!(stream.withdrawn_amount, 300);
}

#[test]
fn test_withdraw_excessive_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 3 * 1000);
    process(env.clone(), id).unwrap();

    let result = withdraw(env.clone(), id, recipient, 500);
    assert_eq!(result, Err(Error::OverWithdraw));
}

#[test]
fn test_withdraw_zero_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    let result = withdraw(env.clone(), id, recipient, 0);
    assert_eq!(result, Err(Error::InvalidAmount));
}

#[test]
fn test_withdraw_negative_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    let result = withdraw(env.clone(), id, recipient, -100);
    assert_eq!(result, Err(Error::InvalidAmount));
}

#[test]
fn test_withdraw_wrong_recipient_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);
    let wrong = Address::generate(&env);

    env.ledger().set_timestamp(1_100 + 5 * 1000);
    process(env.clone(), id).unwrap();

    let result = withdraw(env.clone(), id, wrong, 100);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_withdraw_nonexistent_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let recipient = Address::generate(&env);
    let result = withdraw(env.clone(), 999, recipient, 100);
    assert_eq!(result, Err(Error::NotFound));
}

#[test]
fn test_withdraw_cancelled_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    cancel(env.clone(), id).unwrap();
    let result = withdraw(env.clone(), id, recipient, 100);
    assert_eq!(result, Err(Error::InvalidState));
}

#[test]
fn test_withdraw_full_vested() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 10 * 1000);
    process(env.clone(), id).unwrap();

    let withdrawn = withdraw(env.clone(), id, recipient.clone(), 1000).unwrap();
    assert_eq!(withdrawn, 1000);

    let stream = get_existing(&env, id).unwrap();
    assert_eq!(stream.withdrawn_amount, 1000);
    assert_eq!(stream.status, StreamStatus::Ended);
}

#[test]
fn test_withdraw_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 3 * 1000);
    process(env.clone(), id).unwrap();
    withdraw(env.clone(), id, recipient.clone(), 100).unwrap();

    let events = env.events().all();
    let withdrawn_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let topics = e.0.clone();
            topics.get(0) == Some(Symbol::new(&env, "recurring").into_val(&env))
                && topics.get(1) == Some(Symbol::new(&env, "withdrawn").into_val(&env))
        })
        .collect();
    assert_eq!(withdrawn_events.len(), 1);
}

// ── Cancel tests ──────────────────────────────────────────────────────

#[test]
fn test_cancel_before_any_cycles() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    let stream = cancel(env.clone(), id).unwrap();
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn_amount, 0);
}

#[test]
fn test_cancel_after_some_cycles() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 4 * 1000);
    process(env.clone(), id).unwrap();
    withdraw(env.clone(), id, recipient.clone(), 200).unwrap();

    let stream = cancel(env.clone(), id).unwrap();
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.withdrawn_amount, 200);
}

#[test]
fn test_cancel_nonexistent_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let result = cancel(env.clone(), 999);
    assert_eq!(result, Err(Error::NotFound));
}

#[test]
fn test_cancel_already_cancelled_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    cancel(env.clone(), id).unwrap();
    let result = cancel(env.clone(), id);
    assert_eq!(result, Err(Error::InvalidState));
}

#[test]
fn test_cancel_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    cancel(env.clone(), id).unwrap();

    let events = env.events().all();
    let cancelled_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let topics = e.0.clone();
            topics.get(0) == Some(Symbol::new(&env, "recurring").into_val(&env))
                && topics.get(1) == Some(Symbol::new(&env, "cancelled").into_val(&env))
        })
        .collect();
    assert_eq!(cancelled_events.len(), 1);
}

// ── Math / view tests ─────────────────────────────────────────────────

#[test]
fn test_vested_cycles_basic() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);
    let stream = get_existing(&env, id).unwrap();

    assert_eq!(vested_cycles(&stream, 1_100), 0);
    assert_eq!(vested_cycles(&stream, 1_100 + 1), 0);
    assert_eq!(vested_cycles(&stream, 1_100 + 1_000), 1);
    assert_eq!(vested_cycles(&stream, 1_100 + 5_500), 5);
    assert_eq!(vested_cycles(&stream, 1_100 + 10_000), 10);
    assert_eq!(vested_cycles(&stream, 1_100 + 100_000), 10);
}

#[test]
fn test_vested_cycles_before_start() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);
    let stream = get_existing(&env, id).unwrap();

    assert_eq!(vested_cycles(&stream, 500), 0);
    assert_eq!(vested_cycles(&stream, 1_000), 0);
}

#[test]
fn test_withdrawable_basic() {
    let env = Env::default();
    let stream = RecurringStream {
        id: 1,
        sender: Address::generate(&env),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        amount_per_cycle: 100,
        cycle_duration: 1000,
        total_cycles: 10,
        cycles_completed: 5,
        withdrawn_amount: 200,
        start_time: 1000,
        last_processed_time: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps: 0,
    };

    assert_eq!(withdrawable(&stream, 5000), Ok(300));
}

#[test]
fn test_withdrawable_nothing_vested() {
    let env = Env::default();
    let stream = RecurringStream {
        id: 1,
        sender: Address::generate(&env),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        amount_per_cycle: 100,
        cycle_duration: 1000,
        total_cycles: 10,
        cycles_completed: 0,
        withdrawn_amount: 0,
        start_time: 1000,
        last_processed_time: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps: 0,
    };

    assert_eq!(withdrawable(&stream, 500), Ok(0));
}

#[test]
fn test_withdrawable_fully_withdrawn() {
    let env = Env::default();
    let stream = RecurringStream {
        id: 1,
        sender: Address::generate(&env),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        amount_per_cycle: 100,
        cycle_duration: 1000,
        total_cycles: 10,
        cycles_completed: 10,
        withdrawn_amount: 1000,
        start_time: 1000,
        last_processed_time: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps: 0,
    };

    assert_eq!(withdrawable(&stream, 5000), Ok(0));
}

#[test]
fn test_withdrawable_overflow() {
    let stream = RecurringStream {
        id: 1,
        sender: soroban_sdk::Address::generate(&soroban_sdk::Env::default()),
        recipient: soroban_sdk::Address::generate(&soroban_sdk::Env::default()),
        token: soroban_sdk::Address::generate(&soroban_sdk::Env::default()),
        amount_per_cycle: i128::MAX,
        cycle_duration: 1000,
        total_cycles: 2,
        cycles_completed: 0,
        withdrawn_amount: 0,
        start_time: 1000,
        last_processed_time: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps: 0,
    };

    let result = total_vested_amount(&stream, 5000);
    assert_eq!(result, Err(Error::Overflow));
}

#[test]
fn test_get_nonexistent_fails() {
    let env = Env::default();
    let result = get(env.clone(), 999);
    assert_eq!(result, Err(Error::NotFound));
}

#[test]
fn test_get_withdrawable_nonexistent_fails() {
    let env = Env::default();
    let result = get_withdrawable(env.clone(), 999);
    assert_eq!(result, Err(Error::NotFound));
}

#[test]
fn test_get_vested_nonexistent_fails() {
    let env = Env::default();
    let result = get_vested(env.clone(), 999);
    assert_eq!(result, Err(Error::NotFound));
}

// ── Idempotency / edge case tests ────────────────────────────────────

#[test]
fn test_process_idempotent() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);
    let id = create_default(&env, &sender, &recipient, &token_id);

    env.ledger().set_timestamp(1_100 + 3 * 1000);
    let s1 = process(env.clone(), id).unwrap();
    assert_eq!(s1.cycles_completed, 3);

    let s2 = process(env.clone(), id).unwrap();
    assert_eq!(s2.cycles_completed, 3);
}

#[test]
fn test_multiple_recurring_streams() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let id1 = create_default(&env, &sender, &recipient, &token_id);
    let id2 = create_default(&env, &sender, &recipient, &token_id);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_full_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (sender, recipient, token_id) = init_and_settle_contract(&env);

    let now = env.ledger().timestamp();
    let id = create(
        env.clone(),
        sender.clone(),
        recipient.clone(),
        token_id.clone(),
        100,
        1000,
        5,
        now + 100,
        0,
    )
    .unwrap();

    env.ledger().set_timestamp(1_100 + 3 * 1000);
    process(env.clone(), id).unwrap();
    withdraw(env.clone(), id, recipient.clone(), 200).unwrap();

    let available = get_withdrawable(env.clone(), id).unwrap();
    assert_eq!(available, 100);

    let vested = get_vested(env.clone(), id).unwrap();
    assert_eq!(vested, 300);

    env.ledger().set_timestamp(1_100 + 5 * 1000);
    process(env.clone(), id).unwrap();
    withdraw(env.clone(), id, recipient.clone(), 300).unwrap();

    let stream = get(env.clone(), id).unwrap();
    assert_eq!(stream.status, StreamStatus::Ended);
    assert_eq!(stream.withdrawn_amount, 500);
}

// ── Authorization failure tests ───────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn test_create_requires_auth() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let contract_id = env.register_contract(None, Contract);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &token_id);
    token.mint(&sender, &i128::from(u64::MAX));

    let client = crate::ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    env.mock_auths(&[]);
    client.create_recurring_stream(
        &sender, &recipient, &token_id, &100i128, &1_000u64, &10u64, &1_100u64, &0u32,
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn test_withdraw_requires_auth() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let contract_id = env.register_contract(None, Contract);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &token_id);
    token.mint(&sender, &i128::from(u64::MAX));

    let client = crate::ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let id = client.create_recurring_stream(
        &sender, &recipient, &token_id, &100i128, &1_000u64, &10u64, &1_100u64, &0u32,
    );

    env.ledger().set_timestamp(1_100 + 3 * 1_000);
    client.process_recurring_stream(&id);

    env.mock_auths(&[]);
    client.withdraw_recurring(&id, &recipient, &100i128);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn test_cancel_requires_auth() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let contract_id = env.register_contract(None, Contract);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &token_id);
    token.mint(&sender, &i128::from(u64::MAX));

    let client = crate::ContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let id = client.create_recurring_stream(
        &sender, &recipient, &token_id, &100i128, &1_000u64, &10u64, &1_100u64, &0u32,
    );

    env.mock_auths(&[]);
    client.cancel_recurring_stream(&id);
}
