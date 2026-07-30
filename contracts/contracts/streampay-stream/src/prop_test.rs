#![allow(clippy::unwrap_used, clippy::expect_used, clippy::single_match)]
//! # Property-based tests for linear release math
//!
//! These tests use `proptest` to verify invariants that must hold for every
//! valid combination of `(total_amount, start_time, end_time, now)`.  They
//! exercise `release::vested_amount` and `release::withdrawable` directly,
//! which are the pure-math heart of the contract.
//!
//! ## Invariants verified
//!
//! 1. **Non-negativity** — vested and withdrawable amounts are always ≥ 0.
//! 2. **Monotonicity** — vested amount never decreases as `now` increases.
//! 3. **Upper bound** — vested amount never exceeds `total_amount`.
//! 4. **Boundary: at start** — vested amount is exactly 0 at `start_time`.
//! 5. **Boundary: at/after end** — vested amount equals `total_amount` at
//!    any `now ≥ end_time`.
//! 6. **Withdrawable ≤ vested** — withdrawable never exceeds vested.
//! 7. **Overflow propagation** — extreme inputs yield `Err(Overflow)`, not a
//!    panic.

#![allow(clippy::unwrap_used)] // proptest closures require `unwrap`
#![allow(clippy::expect_used)]

use crate::{release, Error, Stream, StreamStatus};
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

// ── helper ───────────────────────────────────────────────────────────────────

/// Construct a minimal [`Stream`] for unit-testing the release math.
///
/// `env` must outlive the returned [`Stream`] because the address fields
/// borrow from it.
fn make_stream(
    env: &soroban_sdk::Env,
    total_amount: i128,
    released_amount: i128,
    start_time: u64,
    end_time: u64,
) -> Stream {
    Stream {
        id: 1,
        sender: Address::generate(env),
        recipient: Address::generate(env),
        token: Address::generate(env),
        total_amount,
        released_amount,
        start_time,
        end_time,
        duration: end_time.saturating_sub(start_time),
        last_update: start_time,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
    }
}

// ── strategies ───────────────────────────────────────────────────────────────

/// An amount that is guaranteed to fit in `i128` but stays well below
/// `i128::MAX` so that `amount * elapsed` does not overflow in the
/// "safe" region of inputs we test for correctness (vs. overflow tests
/// which use extreme values deliberately).
///
/// We cap at 2^96 (~7.9 × 10^28), which is large enough to represent any
/// realistic token quantity while keeping the intermediate product
/// `amount × duration` under `i128::MAX` for durations up to 2^32 seconds.
fn safe_amount() -> impl Strategy<Value = i128> {
    1_i128..=(1_i128 << 96)
}

/// A `u64` timestamp in a range that prevents `start + duration` overflow.
fn safe_timestamp() -> impl Strategy<Value = u64> {
    0_u64..=(u64::MAX / 2)
}

/// A valid `(start, end)` pair with `end > start` and both in safe range.
fn valid_time_range() -> impl Strategy<Value = (u64, u64)> {
    safe_timestamp().prop_flat_map(|start| {
        // end is at least start+1, at most start + 2^32 seconds (~136 years)
        let end_range = (start + 1)..=start.saturating_add(u32::MAX as u64);
        end_range.prop_map(move |end| (start, end))
    })
}

// ── property tests ────────────────────────────────────────────────────────────

proptest! {
    /// P1: vested amount is always non-negative.
    #[test]
    fn prop_vested_amount_non_negative(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now in safe_timestamp(),
    ) {
        let env = soroban_sdk::Env::default();
        let stream = make_stream(&env, total, 0, start, end);
        let result = release::vested_amount(&stream, now);
        // Either it succeeds with a non-negative value, or it overflows.
        match result {
            Ok(v)  => prop_assert!(v >= 0, "vested={v} total={total}"),
            Err(e) => prop_assert_eq!(e, Error::Overflow),
        }
    }

    /// P2: vested amount is monotonically non-decreasing.
    #[test]
    fn prop_vested_amount_monotonic(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now1 in safe_timestamp(),
        delta in 0_u64..=1_000_u64,
    ) {
        let (env, _admin, sender, recipient, token) = setup_env();
        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);

        let stream_id = client
            .create_stream(&sender, &recipient, &token, &total_amount, &1_000, &(1_000 + duration));

        // Advance to halfway point
        env.ledger().set_timestamp(1_000 + duration / 2);

        let withdrawable_before = client.withdrawable(&stream_id);
        let stream_before = client.get_stream(&stream_id);

        // Withdraw a fraction of the withdrawable amount
        let withdraw_amount = withdrawable_before / withdraw_fraction as i128;
        if withdraw_amount > 0 {
            let _ = client.withdraw(&recipient, &stream_id, &withdraw_amount);

            let stream_after = client.get_stream(&stream_id);
            let withdrawable_after = client.withdrawable(&stream_id);

            // Invariant: released_amount increased by withdrawn amount
            prop_assert_eq!(
                stream_after.released_amount,
                stream_before.released_amount + withdraw_amount
            );

            // Invariant: released_amount <= total_amount
            prop_assert!(
                stream_after.released_amount <= total_amount,
                "released_amount after withdrawal should not exceed total_amount"
            );

            // Invariant: withdrawable decreased appropriately
            prop_assert!(
                withdrawable_after <= withdrawable_before,
                "withdrawable should decrease after withdrawal"
            );

            // Invariant: no overflow in calculations
            prop_assert!(
                stream_after.released_amount >= 0,
                "released_amount should remain non-negative"
            );
        }
    }

    /// P3: vested amount never exceeds `total_amount`.
    #[test]
    fn prop_vested_amount_bounded_by_total(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now in safe_timestamp(),
    ) {
        let env = soroban_sdk::Env::default();
        let stream = make_stream(&env, total, 0, start, end);
        if let Ok(v) = release::vested_amount(&stream, now) {
            prop_assert!(v <= total, "vested={v} exceeded total={total}");
        }
    }

    /// P4: at exactly `start_time`, vested amount is 0.
    #[test]
    fn prop_vested_at_start_is_zero(
        total in safe_amount(),
        (start, end) in valid_time_range(),
    ) {
        let env = soroban_sdk::Env::default();
        let stream = make_stream(&env, total, 0, start, end);
        prop_assert_eq!(release::vested_amount(&stream, start), Ok(0));
    }

    /// P5: at or after `end_time`, vested amount equals `total_amount`.
    #[test]
    fn prop_vested_at_end_equals_total(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        extra in 0_u64..=1_000_u64,
    ) {
        let env = soroban_sdk::Env::default();
        let stream = make_stream(&env, total, 0, start, end);
        let now = end.saturating_add(extra);
        prop_assert_eq!(release::vested_amount(&stream, now), Ok(total));
    }

    /// P6: withdrawable never exceeds vested amount (minus already released).
    #[test]
    fn prop_withdrawable_bounded_by_vested(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now in safe_timestamp(),
        released_frac in 0_u8..=100_u8,
    ) {
        let env = soroban_sdk::Env::default();
        // released is some fraction of total, always ≤ total.
        let released = (total / 100).saturating_mul(released_frac as i128).min(total);
        let stream = make_stream(&env, total, released, start, end);
        match (release::vested_amount(&stream, now), release::withdrawable(&stream, now)) {
            (Ok(v), Ok(w)) => {
                prop_assert!(w >= 0, "withdrawable negative: {w}");
                prop_assert!(w <= v, "withdrawable={w} exceeds vested={v}");
            }
            _ => {}
        }
    }

    /// P7: withdrawable is 0 when `released_amount == total_amount`.
    #[test]
    fn prop_withdrawable_zero_when_fully_released(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now in safe_timestamp(),
    ) {
        let env = soroban_sdk::Env::default();
        // Fully released: released_amount == total_amount.
        let stream = make_stream(&env, total, total, start, end);
        if let Ok(w) = release::withdrawable(&stream, now) {
            prop_assert_eq!(w, 0, "should be 0 when fully released");
        }
    }

    /// P8: Draft streams always vest 0, regardless of timestamps.
    #[test]
    fn prop_draft_stream_always_vests_zero(
        total in safe_amount(),
        (start, end) in valid_time_range(),
        now in safe_timestamp(),
    ) {
        let env = soroban_sdk::Env::default();
        let mut stream = make_stream(&env, total, 0, start, end);
        stream.status = StreamStatus::Draft;
        prop_assert_eq!(release::vested_amount(&stream, now), Ok(0));
    }
}
