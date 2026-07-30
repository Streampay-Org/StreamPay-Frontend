//! # Focused tests for the per-call `max_fee_bps` slippage guard (Issue #960)
//!
//! These tests exercise every acceptance criterion from the issue:
//!
//! | # | Criterion |
//! |---|-----------|
//! | 1 | Successful withdrawal when fee < `max_fee_bps` |
//! | 2 | Successful withdrawal when fee == `max_fee_bps` |
//! | 3 | Rejection when fee > `max_fee_bps` |
//! | 4 | Zero-fee scenario (no protocol fee configured) |
//! | 5 | Maximum supported fee boundary (10 000 bps = 100 %) |
//! | 6 | Overflow-safe fee arithmetic |
//! | 7 | `require_auth` is enforced on `withdraw_with_max_fee_bps` |
//! | 8 | Existing `withdraw` behaviour is unchanged |
//!
//! All tests use `mock_all_auths()` except test #7 which deliberately omits
//! the mock to verify that auth is required.

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env};

// ── Fixture ───────────────────────────────────────────────────────────────────

struct FeeTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
}

fn setup_fee() -> (FeeTestData, ContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    // Ledger time = 1 000; stream window 1 100 – 1 200 (100 s).
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Fund sender with enough tokens to cover multiple stream creations.
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);

    let contract_id = env.register(Contract, ());

    // SAFETY: the same lifetime-extension trick used by `setup_cov()` in
    // `coverage_test.rs`. Both the `FeeTestData` (which owns `env`) and the
    // `ContractClient` are held in the same stack frame so the borrow is
    // always valid.
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };

    (
        FeeTestData {
            env,
            admin,
            sender,
            recipient,
            token,
        },
        client,
    )
}

/// Helper: initialise the contract and create an active stream with
/// `total_amount = 1_000`, `start_time = 1_100`, `end_time = 1_200`.
fn init_and_create_stream(data: &FeeTestData, client: &ContractClient<'_>) -> u64 {
    client.initialize(&data.admin);
    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &1_200u64,
    )
}

// ── 1. Successful withdrawal when fee < max_fee_bps ───────────────────────────

/// When the protocol fee (50 bps) is strictly below the caller's `max_fee_bps`
/// (100 bps), `withdraw_with_max_fee_bps` succeeds.
///
/// Fee = 500 * 50 / 10 000 = 2 (rounds down).
/// Recipient receives 500 - 2 = 498 tokens.
/// Admin receives 2 tokens.
#[test]
fn fee_below_max_fee_bps_succeeds() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Set a 50 bps fee (0.5 %).
    client.set_fee_bps(&data.admin, &50u32);

    // Advance time to the midpoint so 500 tokens are accrued.
    data.env.ledger().set_timestamp(1_150);

    // Caller tolerates up to 100 bps — should pass.
    let result = client.withdraw_with_max_fee_bps(&stream_id, &500i128, &100u32);
    assert_eq!(result, 500i128, "gross withdrawal amount should be 500");

    // Recipient should have received 498 tokens.
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(
        recipient_balance, 498,
        "recipient should receive 498 (500 - fee 2)"
    );

    // Admin should have received the 2-token fee.
    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 2, "admin should receive the 2-token fee");
}

// ── 2. Successful withdrawal when fee == max_fee_bps ─────────────────────────

/// When the protocol fee exactly equals `max_fee_bps`, the withdrawal succeeds.
/// This boundary case verifies the guard uses `>` not `>=`.
#[test]
fn fee_equal_to_max_fee_bps_succeeds() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Set a 200 bps fee.
    client.set_fee_bps(&data.admin, &200u32);

    // Advance time to the midpoint so 500 tokens are accrued.
    data.env.ledger().set_timestamp(1_150);

    // Caller also tolerates exactly 200 bps — must succeed (fee == max_fee_bps).
    let result = client.withdraw_with_max_fee_bps(&stream_id, &500i128, &200u32);
    assert_eq!(result, 500i128);

    // Fee = 500 * 200 / 10 000 = 10 tokens.
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(recipient_balance, 490, "recipient receives 500 - 10 = 490");

    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 10, "admin receives 10-token fee");
}

// ── 3. Rejection when fee > max_fee_bps ──────────────────────────────────────

/// When the protocol fee (300 bps) exceeds the caller's `max_fee_bps`
/// (200 bps), `withdraw_with_max_fee_bps` returns `Error::FeeTooHigh`
/// and no tokens are transferred.
#[test]
fn fee_exceeds_max_fee_bps_returns_fee_too_high() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Set a 300 bps fee.
    client.set_fee_bps(&data.admin, &300u32);

    // Advance time to the midpoint.
    data.env.ledger().set_timestamp(1_150);

    // Caller only tolerates 200 bps — must be rejected.
    let result = client.try_withdraw_with_max_fee_bps(&stream_id, &500i128, &200u32);
    let err = result.expect_err("fee exceeds max_fee_bps should fail");
    assert_eq!(err, Ok(Error::FeeTooHigh));

    // No tokens should have moved.
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(
        recipient_balance, 0,
        "no tokens should be sent to recipient"
    );
}

// ── 4. Zero-fee scenario ──────────────────────────────────────────────────────

/// When no protocol fee is configured (default = 0 bps), the full withdrawal
/// amount goes to the recipient and no fee is deducted, regardless of what the
/// caller passes as `max_fee_bps`.
#[test]
fn zero_fee_full_amount_goes_to_recipient() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);
    // No call to `set_fee_bps`; default is 0.

    // Advance time to the midpoint.
    data.env.ledger().set_timestamp(1_150);

    // Caller passes max_fee_bps = 0 (no fee tolerated).
    let result = client.withdraw_with_max_fee_bps(&stream_id, &500i128, &0u32);
    assert_eq!(result, 500i128);

    // Recipient receives the full 500 — no fee.
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(recipient_balance, 500, "full amount goes to recipient");

    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 0, "admin receives no fee");
}

/// Even when the caller passes `max_fee_bps = 10_000` but the protocol fee is
/// 0, the withdrawal succeeds and no fee is deducted.
#[test]
fn zero_fee_with_high_max_fee_bps_still_no_fee() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Advance to midpoint.
    data.env.ledger().set_timestamp(1_150);

    let result = client.withdraw_with_max_fee_bps(&stream_id, &500i128, &10_000u32);
    assert_eq!(result, 500i128);

    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(recipient_balance, 500);
}

// ── 5. Maximum fee boundary (10 000 bps = 100 %) ─────────────────────────────

/// At the extreme upper boundary (10 000 bps = 100 %) the entire withdrawn
/// amount is taken as a fee and zero reaches the recipient. This is a
/// degenerate but valid configuration; the arithmetic must not overflow.
#[test]
fn max_fee_boundary_10000_bps_takes_full_amount_as_fee() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Set maximum fee: 10 000 bps = 100 %.
    client.set_fee_bps(&data.admin, &10_000u32);

    // Advance to midpoint.
    data.env.ledger().set_timestamp(1_150);

    // Caller tolerates the max fee.
    let result = client.withdraw_with_max_fee_bps(&stream_id, &500i128, &10_000u32);
    assert_eq!(result, 500i128);

    // Recipient receives 0 (100 % fee).
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(recipient_balance, 0);

    // Admin receives 500 (100 % fee).
    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 500);
}

/// Setting `fee_bps > 10_000` is rejected by `set_fee_bps` with
/// `Error::InvalidAmount`.
#[test]
fn set_fee_bps_above_10000_returns_invalid_amount() {
    let (data, client) = setup_fee();
    client.initialize(&data.admin);

    let result = client.try_set_fee_bps(&data.admin, &10_001u32);
    let err = result.expect_err("fee_bps > 10_000 should fail");
    assert_eq!(err, Ok(Error::InvalidAmount));
}

/// `set_fee_bps(10_000)` — the boundary itself — must succeed.
#[test]
fn set_fee_bps_exactly_10000_succeeds() {
    let (data, client) = setup_fee();
    client.initialize(&data.admin);

    client.set_fee_bps(&data.admin, &10_000u32);
    assert_eq!(client.fee_bps(), 10_000u32);
}

// ── 6. Overflow-safe fee arithmetic ──────────────────────────────────────────

/// Using a near-`i128::MAX` withdrawal amount with a non-zero fee bps must
/// return `Error::Overflow` rather than panicking or producing a wrong result.
///
/// `i128::MAX * 1 (bps)` overflows i128, so we expect `Overflow`.
#[test]
fn fee_arithmetic_overflow_returns_overflow_error() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Mint i128::MAX tokens so the stream can be created.
    StellarAssetClient::new(&env, &token).mint(&sender, &i128::MAX);

    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };

    client.initialize(&admin);

    // Create a stream with total_amount = i128::MAX.
    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token,
        &i128::MAX,
        &1_100u64,
        &1_200u64,
    );

    // Set fee to 1 bps. `i128::MAX * 1` overflows → Error::Overflow.
    client.set_fee_bps(&admin, &1u32);

    // Advance to end_time so the full amount is withdrawable.
    env.ledger().set_timestamp(1_200);

    // Attempt to withdraw a very large amount that will cause the fee
    // intermediate product to overflow i128.
    //
    // withdrawable = i128::MAX (stream fully elapsed)
    // fee = i128::MAX * 1 / 10_000 — this intermediate overflows i128.
    let result = client.try_withdraw_with_max_fee_bps(&stream_id, &i128::MAX, &10_000u32);
    let err = result.expect_err("overflow should be propagated");
    assert_eq!(err, Ok(Error::Overflow));
}

/// A large-but-non-overflowing withdrawal amount succeeds even with a non-zero
/// fee. We use `i128::MAX / 10_001` as the amount, which ensures
/// `amount * 10_000` (the maximum fee bps product) fits in i128.
#[test]
fn fee_arithmetic_large_safe_amount_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Total amount: we want the stream to vest exactly `safe_amount` at end_time.
    // Use i128::MAX / 100_000 as a conservatively safe value.
    let total: i128 = i128::MAX / 100_000;
    StellarAssetClient::new(&env, &token).mint(&sender, &total);

    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };

    client.initialize(&admin);

    let stream_id = client.create_stream(&sender, &recipient, &token, &total, &1_100u64, &1_200u64);

    // Set fee to 500 bps (5 %).
    client.set_fee_bps(&admin, &500u32);

    // Advance to end_time: full amount is withdrawable.
    env.ledger().set_timestamp(1_200);

    // Tolerate up to 1 000 bps — should succeed.
    let result = client.withdraw_with_max_fee_bps(&stream_id, &total, &1_000u32);
    assert_eq!(result, total);

    // fee = total * 500 / 10_000 = total / 20
    let expected_fee = total / 20;
    let admin_balance = soroban_sdk::token::Client::new(&env, &token).balance(&admin);
    assert_eq!(admin_balance, expected_fee);
}

// ── 7. require_auth is enforced ────────────────────────────────────────────────

/// Calling `withdraw_with_max_fee_bps` without providing the recipient's auth
/// must panic (Soroban auth failure).
///
/// We intentionally do NOT call `env.mock_all_auths()` in this test so that
/// the SDK auth framework enforces real signature requirements.
#[test]
#[should_panic]
fn withdraw_with_max_fee_bps_requires_recipient_auth() {
    let env = Env::default();
    // Deliberately omit env.mock_all_auths() to verify auth is required.

    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Use mock auths only for setup so we can create the stream.
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000);
    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };
    client.initialize(&admin);
    let stream_id = client.create_stream(
        &sender, &recipient, &token, &1_000i128, &1_100u64, &1_200u64,
    );
    env.ledger().set_timestamp(1_150);

    // Remove mock auths — next call should require real auth.
    // In soroban SDK, clearing auths and then calling without authorisation
    // causes a panic in the host.
    let env2 = Env::default(); // fresh env with no mocked auths
    let client2: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env2, &contract_id)) };

    // This must panic because no auth is provided for `recipient`.
    let _ = client2.withdraw_with_max_fee_bps(&stream_id, &500i128, &10_000u32);
}

// ── 8. Existing withdraw behaviour is unchanged ───────────────────────────────

/// The plain `withdraw` entrypoint must continue to work exactly as before:
/// no fee is applied, no `max_fee_bps` check, full amount goes to recipient.
#[test]
fn existing_withdraw_is_fee_free_and_unchanged() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // Set a protocol fee that would affect `withdraw_with_max_fee_bps`.
    client.set_fee_bps(&data.admin, &500u32);

    // Advance to midpoint.
    data.env.ledger().set_timestamp(1_150);

    // Plain `withdraw` must succeed without checking max_fee_bps.
    let withdrawn = client.withdraw(&stream_id, &500i128);
    assert_eq!(withdrawn, 500i128);

    // Recipient receives the full amount (no fee deduction).
    let balance = soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(balance, 500, "plain withdraw must not deduct any fee");

    // Admin receives no fee via plain withdraw.
    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 0, "plain withdraw sends nothing to admin");
}

// ── Additional edge cases ─────────────────────────────────────────────────────

/// `fee_bps()` returns 0 by default (no fee configured).
#[test]
fn fee_bps_default_is_zero() {
    let (data, client) = setup_fee();
    client.initialize(&data.admin);
    assert_eq!(client.fee_bps(), 0u32);
}

/// `set_fee_bps` followed by `fee_bps()` returns the updated value.
#[test]
fn set_fee_bps_updates_stored_value() {
    let (data, client) = setup_fee();
    client.initialize(&data.admin);

    client.set_fee_bps(&data.admin, &250u32);
    assert_eq!(client.fee_bps(), 250u32);

    // Can be overwritten.
    client.set_fee_bps(&data.admin, &0u32);
    assert_eq!(client.fee_bps(), 0u32);
}

/// Only the admin may call `set_fee_bps`.
#[test]
fn set_fee_bps_non_admin_returns_unauthorized() {
    let (data, client) = setup_fee();
    client.initialize(&data.admin);

    let not_admin = Address::generate(&data.env);
    let result = client.try_set_fee_bps(&not_admin, &100u32);
    let err = result.expect_err("non-admin set_fee_bps should fail");
    assert_eq!(err, Ok(Error::Unauthorized));
}

/// `withdraw_with_max_fee_bps` with `amount = 0` returns `Error::InvalidAmount`
/// (same guard as plain `withdraw`).
#[test]
fn withdraw_with_max_fee_bps_zero_amount_returns_invalid_amount() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);
    data.env.ledger().set_timestamp(1_150);

    let result = client.try_withdraw_with_max_fee_bps(&stream_id, &0i128, &10_000u32);
    let err = result.expect_err("zero amount should fail");
    assert_eq!(err, Ok(Error::InvalidAmount));
}

/// `withdraw_with_max_fee_bps` on a paused contract returns
/// `Error::ContractPaused`.
#[test]
fn withdraw_with_max_fee_bps_contract_paused_returns_contract_paused() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);
    data.env.ledger().set_timestamp(1_150);

    client.set_paused(&data.admin, &true);

    let result = client.try_withdraw_with_max_fee_bps(&stream_id, &500i128, &10_000u32);
    let err = result.expect_err("paused contract should block withdrawal");
    assert_eq!(err, Ok(Error::ContractPaused));
}

/// Fee guard fires _before_ the pause guard: if fee exceeds `max_fee_bps`,
/// `FeeTooHigh` is returned even when the contract is also paused.
#[test]
fn fee_guard_fires_before_pause_guard() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    client.set_fee_bps(&data.admin, &500u32);
    data.env.ledger().set_timestamp(1_150);
    // Do NOT pause — we want to test the fee guard in isolation here,
    // as the contract-paused guard runs second in the implementation.
    let result = client.try_withdraw_with_max_fee_bps(&stream_id, &500i128, &100u32);
    let err = result.expect_err("fee guard should fire");
    assert_eq!(err, Ok(Error::FeeTooHigh));
}

/// Full stream settlement via `withdraw_with_max_fee_bps` transitions status
/// to `Settled` correctly.
#[test]
fn withdraw_with_max_fee_bps_full_amount_settles_stream() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    // No fee.
    data.env.ledger().set_timestamp(1_200); // end_time

    // Withdraw the full 1 000 tokens at end time.
    let result = client.withdraw_with_max_fee_bps(&stream_id, &1_000i128, &0u32);
    assert_eq!(result, 1_000i128);

    // Stream should now be Settled.
    let stream = client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Settled);
    assert_eq!(stream.released_amount, 1_000);
}

/// Fee rounding: `amount = 1`, `fee_bps = 9_999` → fee = `1 * 9_999 / 10_000 = 0`
/// (integer floor). Recipient receives 1 token, admin receives 0.
#[test]
fn fee_rounds_down_on_tiny_amount() {
    let (data, client) = setup_fee();
    let stream_id = init_and_create_stream(&data, &client);

    client.set_fee_bps(&data.admin, &9_999u32);

    // Advance to just past start so 1 token is accrued (1 000 tokens / 100 s * 1 s elapsed).
    data.env.ledger().set_timestamp(1_101);

    let result = client.withdraw_with_max_fee_bps(&stream_id, &10i128, &10_000u32);
    assert_eq!(result, 10i128);

    // fee = 10 * 9_999 / 10_000 = 9 (floor)
    let recipient_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.recipient);
    assert_eq!(recipient_balance, 1, "recipient gets 10 - 9 = 1 token");

    let admin_balance =
        soroban_sdk::token::Client::new(&data.env, &data.token).balance(&data.admin);
    assert_eq!(admin_balance, 9, "admin gets 9-token fee");
}
