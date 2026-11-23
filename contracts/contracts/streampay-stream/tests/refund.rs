//! Refund splitting tests for `cancel_stream` entrypoint.
//!
//! This test suite covers boundary conditions and edge cases for the
//! sender/recipient refund split when a stream is cancelled. The refund
//! logic is:
//!
//! - **Recipient** receives: vested_amount - released_amount
//! - **Sender** receives: total_amount - vested_amount
//!
//! Tests verify that the split is correct across various stream states,
//! withdrawal patterns, and edge cases.

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{symbol_short, token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient, StreamStatus};

/// Test data structure for refund tests.
struct RefundTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
    client: ContractClient<'static>,
}

/// Sets up the test environment with a deployed contract and funded sender.
fn setup_refund_test() -> RefundTestData {
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

    // Initialize contract
    client.initialize(&admin);

    // Fund sender with ample tokens
    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000_000);

    // Recipient needs trustline to receive tokens
    StellarAssetClient::new(&env, &token).mint(&recipient, &0);

    RefundTestData {
        env,
        admin,
        sender,
        recipient,
        token,
        client,
    }
}

/// Creates a stream with the given parameters.
fn create_stream(
    data: &RefundTestData,
    total_amount: i128,
    start_time: u64,
    end_time: u64,
) -> u64 {
    data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &total_amount,
        &start_time,
        &end_time,
    )
}

/// Gets the token balance of an address.
fn get_balance(env: &Env, token: &Address, address: &Address) -> i128 {
    StellarAssetClient::new(env, token).balance(address)
}

// ── Boundary: Cancel immediately (0 vested) ─────────────────────────────────

#[test]
fn cancel_immediately_refunds_all_to_sender() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream that starts in the future
    let stream_id = create_stream(
        &data,
        total_amount,
        10_000, // start in future
        20_000, // end in future
    );

    // Cancel immediately (no time has passed, vested = 0)
    data.env.ledger().set_timestamp(1_000);
    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // Sender should receive full refund
    assert_eq!(
        sender_balance_after - sender_balance_before,
        total_amount,
        "Sender should receive full amount when cancelled immediately"
    );

    // Recipient should receive nothing
    assert_eq!(
        recipient_balance_after - recipient_balance_before,
        0,
        "Recipient should receive nothing when cancelled immediately"
    );

    // Stream should be cancelled
    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

// ── Boundary: Cancel after full vesting ───────────────────────────────────

#[test]
fn cancel_after_full_vesting_pays_all_to_recipient() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000, // start now
        2_000, // end in future
    );

    // Advance past end_time (fully vested)
    data.env.ledger().set_timestamp(3_000);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // Sender should receive nothing (all vested)
    assert_eq!(
        sender_balance_after - sender_balance_before,
        0,
        "Sender should receive nothing when fully vested"
    );

    // Recipient should receive full amount
    assert_eq!(
        recipient_balance_after - recipient_balance_before,
        total_amount,
        "Recipient should receive full amount when fully vested"
    );
}

// ── Boundary: Cancel with partial vesting (no withdrawals) ─────────────────

#[test]
fn cancel_with_partial_vesting_splits_correctly() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create 10-second stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Advance to 50% through the stream
    data.env.ledger().set_timestamp(1_500);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // At 50%, recipient should get 500k, sender should get 500k
    let recipient_payout = recipient_balance_after - recipient_balance_before;
    let sender_refund = sender_balance_after - sender_balance_before;

    assert_eq!(recipient_payout, 500_000, "Recipient should get 50%");
    assert_eq!(sender_refund, 500_000, "Sender should get 50%");
    assert_eq!(
        recipient_payout + sender_refund,
        total_amount,
        "Total payout should equal total amount"
    );
}

// ── Boundary: Cancel with partial withdrawals ─────────────────────────────

#[test]
fn cancel_with_withdrawals_pays_vested_minus_released() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Advance to 50% vested
    data.env.ledger().set_timestamp(1_500);

    // Withdraw 200k (recipient now has 200k, 300k still vested but not withdrawn)
    data.client.withdraw(&stream_id, &200_000);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    let recipient_payout = recipient_balance_after - recipient_balance_before;
    let sender_refund = sender_balance_after - sender_balance_before;

    // Recipient should get vested (500k) - released (200k) = 300k
    assert_eq!(recipient_payout, 300_000, "Recipient should get vested minus released");
    // Sender should get unvested (500k)
    assert_eq!(sender_refund, 500_000, "Sender should get unvested amount");
    assert_eq!(
        recipient_payout + sender_refund + 200_000, // +200k already withdrawn
        total_amount,
        "Total should equal original amount"
    );
}

// ── Boundary: Cancel after full withdrawal ────────────────────────────────

#[test]
fn cancel_after_full_withdrawal_refunds_nothing() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Advance past end time
    data.env.ledger().set_timestamp(3_000);

    // Withdraw full amount
    data.client.withdraw(&stream_id, &1_000_000);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // Both should receive nothing (all already withdrawn)
    assert_eq!(
        sender_balance_after - sender_balance_before,
        0,
        "Sender should receive nothing after full withdrawal"
    );
    assert_eq!(
        recipient_balance_after - recipient_balance_before,
        0,
        "Recipient should receive nothing after full withdrawal"
    );
}

// ── Boundary: Cancel paused stream ─────────────────────────────────────────

#[test]
fn cancel_paused_stream_splits_correctly() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        3_000,
    );

    // Advance to 1/3 through
    data.env.ledger().set_timestamp(2_000);

    // Pause the stream
    data.client.pause(&stream_id);

    // Advance further (time passes while paused, but no accrual)
    data.env.ledger().set_timestamp(2_500);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // At pause time (1/3 vested), recipient should get 333k, sender gets 667k
    let recipient_payout = recipient_balance_after - recipient_balance_before;
    let sender_refund = sender_balance_after - sender_balance_before;

    assert_eq!(recipient_payout, 333_333, "Recipient should get vested at pause time");
    assert_eq!(sender_refund, 666_667, "Sender should get unvested amount");
}

// ── Boundary: Cancel draft stream ───────────────────────────────────────────

#[test]
fn cancel_draft_stream_refunds_all_to_sender() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create a draft stream by setting start_time in the far future
    // Note: The current implementation doesn't have a draft parameter,
    // so we simulate by cancelling before start_time
    let stream_id = create_stream(
        &data,
        total_amount,
        100_000, // far in future
        200_000,
    );

    // Cancel before start_time (effectively draft state)
    data.env.ledger().set_timestamp(1_000);

    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    // Sender should receive full refund (0 vested)
    assert_eq!(
        sender_balance_after - sender_balance_before,
        total_amount,
        "Sender should receive full amount for draft stream"
    );
    assert_eq!(
        recipient_balance_after - recipient_balance_before,
        0,
        "Recipient should receive nothing for draft stream"
    );
}

// ── Edge case: Very small amounts ─────────────────────────────────────────

#[test]
fn cancel_with_small_amounts_handles_correctly() {
    let mut data = setup_refund_test();
    let total_amount = 1i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Advance to 50%
    data.env.ledger().set_timestamp(1_500);

    data.client.cancel_stream(&stream_id);

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

// ── Edge case: Very large amounts ─────────────────────────────────────────

#[test]
fn cancel_with_large_amounts_no_overflow() {
    let mut data = setup_refund_test();
    let total_amount = i128::MAX / 2;

    // Fund sender with large amount
    StellarAssetClient::new(&data.env, &data.token).mint(&data.sender, &total_amount);

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Advance to 50%
    data.env.ledger().set_timestamp(1_500);

    // Should not overflow
    data.client.cancel_stream(&stream_id);

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

// ── Edge case: Multiple withdrawals before cancel ─────────────────────────

#[test]
fn cancel_with_multiple_withdrawals() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        3_000,
    );

    // First withdrawal at 1/3
    data.env.ledger().set_timestamp(2_000);
    data.client.withdraw(&stream_id, &200_000);

    // Second withdrawal at 2/3
    data.env.ledger().set_timestamp(3_000);
    data.client.withdraw(&stream_id, &200_000);

    // Cancel at 2/3 (total vested = 666k, released = 400k, remaining vested = 266k)
    let sender_balance_before = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_before = get_balance(&data.env, &data.token, &data.recipient);

    data.client.cancel_stream(&stream_id);

    let sender_balance_after = get_balance(&data.env, &data.token, &data.sender);
    let recipient_balance_after = get_balance(&data.env, &data.token, &data.recipient);

    let recipient_payout = recipient_balance_after - recipient_balance_before;
    let sender_refund = sender_balance_after - sender_balance_before;

    // Recipient should get remaining vested (266k)
    assert_eq!(recipient_payout, 266_666, "Recipient should get remaining vested");
    // Sender should get unvested (334k)
    assert_eq!(sender_refund, 333_334, "Sender should get unvested amount");
}

// ── Edge case: Cancel at exact boundaries ─────────────────────────────────

#[test]
fn cancel_at_start_time() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Cancel exactly at start_time (0 vested)
    data.env.ledger().set_timestamp(1_000);

    data.client.cancel_stream(&stream_id);

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

#[test]
fn cancel_at_end_time() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Cancel exactly at end_time (fully vested)
    data.env.ledger().set_timestamp(2_000);

    data.client.cancel_stream(&stream_id);

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

// ── Error cases ─────────────────────────────────────────────────────────────

#[test]
fn cancel_already_settled_fails() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Settle the stream
    data.env.ledger().set_timestamp(3_000);
    data.client.settle(&stream_id);

    // Try to cancel settled stream
    let result = data.client.try_cancel_stream(&stream_id);
    assert!(result.is_err(), "Cancel of settled stream should fail");
}

#[test]
fn cancel_already_cancelled_fails() {
    let mut data = setup_refund_test();
    let total_amount = 1_000_000i128;

    // Create stream
    let stream_id = create_stream(
        &data,
        total_amount,
        1_000,
        2_000,
    );

    // Cancel once
    data.client.cancel_stream(&stream_id);

    // Try to cancel again
    let result = data.client.try_cancel_stream(&stream_id);
    assert!(result.is_err(), "Cancel of already cancelled stream should fail");
}

#[test]
fn cancel_nonexistent_stream_fails() {
    let data = setup_refund_test();

    // Try to cancel non-existent stream
    let result = data.client.try_cancel_stream(&999);
    assert!(result.is_err(), "Cancel of non-existent stream should fail");
}
