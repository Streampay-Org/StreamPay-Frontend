//! # Per-stream fee logic (issue #947)
//!
//! This module implements configurable **per-stream fee basis points (bps)**.
//! When a stream is created the sender may supply a `fee_bps` value that is
//! recorded on the stream and applied every time the recipient calls
//! [`crate::Contract::withdraw`].
//!
//! ## Basis-points convention
//!
//! | `fee_bps` | Effective rate |
//! |-----------|---------------|
//! | `0`       | 0 % — no fee  |
//! | `100`     | 1 %           |
//! | `500`     | 5 %           |
//! | `10_000`  | 100 %         |
//!
//! `fee_bps` must be in the range `[0, MAX_FEE_BPS]`. Attempting to create a
//! stream with a value outside this range returns
//! [`crate::Error::InvalidFeeBps`].
//!
//! ## Fee recipient
//!
//! Protocol fees are collected by the **fee collector** address stored in
//! instance storage. The admin sets this address via
//! [`crate::Contract::set_fee_collector`]. If no fee collector has been
//! configured (or `fee_bps == 0`) the fee calculation is a no-op and no extra
//! transfer occurs.
//!
//! ## Storage layout
//!
//! | Key | Tier | Description |
//! |-----|------|-------------|
//! | `FeeDataKey::DefaultFeeBps` | Instance | Global default `fee_bps` used when streams do not specify one. Defaults to `0`. |
//! | `FeeDataKey::FeeCollector` | Instance | Address that receives collected fees. |
//! | `FeeDataKey::StreamFeeBps(id)` | Persistent | Per-stream `fee_bps` override written at creation time. |

use soroban_sdk::{contracttype, Address, Env};

use crate::Error;

// ── Constants ────────────────────────────────────────────────────────────────

/// Maximum allowed fee in basis points (100 % = 10 000 bps).
///
/// Streams with a `fee_bps` value above this constant are rejected at creation
/// time with [`Error::InvalidFeeBps`].
pub const MAX_FEE_BPS: u32 = 10_000;

/// Divisor used for basis-point arithmetic: `fee = amount * bps / BPS_DIVISOR`.
const BPS_DIVISOR: i128 = 10_000;

// ── TTL constants (aligned with stream row cadence) ─────────────────────────

/// Instance-storage TTL threshold for fee configuration keys.
const INSTANCE_TTL_MIN_REMAINING: u32 = 120_960; // ~1 week at 5-second ledgers
/// Instance-storage TTL target for fee configuration keys.
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400; // ~1 month at 5-second ledgers
/// Persistent-storage TTL threshold for per-stream fee-bps entries.
const STREAM_FEE_TTL_MIN_REMAINING: u32 = 241_920; // ~2 weeks at 5-second ledgers
/// Persistent-storage TTL target for per-stream fee-bps entries.
const STREAM_FEE_TTL_EXTEND_TO: u32 = 1_555_200; // ~3 months at 5-second ledgers
/// Persistent-storage TTL threshold for accumulated-fee balance entries.
/// Matches the stream-row cadence so a fee balance cannot archive before its stream.
const ACCUM_FEE_TTL_MIN_REMAINING: u32 = 241_920; // ~2 weeks at 5-second ledgers
/// Persistent-storage TTL target for accumulated-fee balance entries.
const ACCUM_FEE_TTL_EXTEND_TO: u32 = 1_555_200; // ~3 months at 5-second ledgers

// ── Storage key discriminants ────────────────────────────────────────────────

/// Ledger storage keys used by the fee subsystem.
///
/// These are intentionally separate from the main `DataKey` enum in `storage.rs`
/// so the fee module remains self-contained and easy to review.
#[derive(Clone)]
#[contracttype]
pub(crate) enum FeeDataKey {
    /// Global default `fee_bps` applied when a stream has no per-stream
    /// override. Stored in instance storage; defaults to `0`.
    DefaultFeeBps,
    /// Address of the protocol fee collector. Stored in instance storage.
    FeeCollector,
    /// Per-stream `fee_bps` override keyed by stream ID. Stored in persistent
    /// storage alongside the stream row. Written at stream-creation time and
    /// read on every withdrawal.
    StreamFeeBps(u64),
    /// Accumulated (un-swept) protocol fee balance for a stream, denominated in
    /// the stream's token's smallest unit.  Written by the withdraw path every
    /// time a fee is charged, and zeroed by `fee_sweep.rs` after each sweep.
    ///
    /// Stored in persistent storage with the same TTL cadence as the stream row
    /// itself so it cannot archive while the stream is active.
    AccumulatedFees(u64),
}

// ── Internal TTL helpers ─────────────────────────────────────────────────────

fn extend_instance_ttl(env: &Env) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(INSTANCE_TTL_MIN_REMAINING);
    let target = env
        .ledger()
        .sequence()
        .saturating_add(INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

fn extend_stream_fee_ttl(env: &Env, stream_id: u64) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(STREAM_FEE_TTL_MIN_REMAINING);
    let target = env
        .ledger()
        .sequence()
        .saturating_add(STREAM_FEE_TTL_EXTEND_TO);
    env.storage()
        .persistent()
        .extend_ttl(&FeeDataKey::StreamFeeBps(stream_id), threshold, target);
}

fn extend_accum_fee_ttl(env: &Env, stream_id: u64) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(ACCUM_FEE_TTL_MIN_REMAINING);
    let target = env
        .ledger()
        .sequence()
        .saturating_add(ACCUM_FEE_TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(
        &FeeDataKey::AccumulatedFees(stream_id),
        threshold,
        target,
    );
}

// ── Public API: validation ────────────────────────────────────────────────────

/// Validates that `fee_bps` is within the allowed range `[0, MAX_FEE_BPS]`.
///
/// # Errors
/// - [`Error::InvalidFeeBps`] if `fee_bps > MAX_FEE_BPS`.
pub fn validate_fee_bps(fee_bps: u32) -> Result<(), Error> {
    if fee_bps > MAX_FEE_BPS {
        return Err(Error::InvalidFeeBps);
    }
    Ok(())
}

// ── Public API: fee computation ───────────────────────────────────────────────

/// Result of [`apply_fee`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeResult {
    /// Amount sent to the fee collector (may be `0` if no fee or no collector).
    pub fee_amount: i128,
    /// Net amount forwarded to the stream recipient (`amount - fee_amount`).
    pub net_amount: i128,
}

/// Computes the fee split for `amount` at `fee_bps` basis points.
///
/// The fee is computed as `floor(amount * fee_bps / 10_000)` using
/// overflow-safe checked arithmetic. The net amount is `amount - fee_amount`.
///
/// When `fee_bps == 0` or `amount == 0`, both operations short-circuit and
/// return `fee_amount = 0, net_amount = amount` without touching storage.
///
/// # Errors
/// - [`Error::Overflow`] if `amount * fee_bps` overflows `i128`.
///
/// # Panics
/// Never panics; all arithmetic uses checked operations.
pub fn apply_fee(amount: i128, fee_bps: u32) -> Result<FeeResult, Error> {
    if fee_bps == 0 || amount <= 0 {
        return Ok(FeeResult {
            fee_amount: 0,
            net_amount: amount,
        });
    }

    let fee_bps_i128 = i128::from(fee_bps);
    let fee_amount = amount
        .checked_mul(fee_bps_i128)
        .ok_or(Error::Overflow)?
        .checked_div(BPS_DIVISOR)
        .ok_or(Error::Overflow)?;

    let net_amount = amount.checked_sub(fee_amount).ok_or(Error::Overflow)?;

    Ok(FeeResult {
        fee_amount,
        net_amount,
    })
}

// ── Public API: default fee storage ──────────────────────────────────────────

/// Stores the global default `fee_bps` in instance storage.
///
/// Called by [`crate::Contract::set_default_fee_bps`]. The value must have been
/// validated by the caller via [`validate_fee_bps`] before calling this
/// function.
pub fn set_default_fee_bps(env: &Env, fee_bps: u32) {
    env.storage()
        .instance()
        .set(&FeeDataKey::DefaultFeeBps, &fee_bps);
    extend_instance_ttl(env);
}

/// Returns the global default `fee_bps` from instance storage.
///
/// Returns `0` if no default has been set.
pub fn get_default_fee_bps(env: &Env) -> u32 {
    let val: Option<u32> = env.storage().instance().get(&FeeDataKey::DefaultFeeBps);
    if val.is_some() {
        extend_instance_ttl(env);
    }
    val.unwrap_or(0)
}

// ── Public API: fee collector storage ────────────────────────────────────────

/// Stores the fee collector address in instance storage.
///
/// Called by [`crate::Contract::set_fee_collector`].
pub fn set_fee_collector(env: &Env, collector: &Address) {
    env.storage()
        .instance()
        .set(&FeeDataKey::FeeCollector, collector);
    extend_instance_ttl(env);
}

/// Returns the fee collector address from instance storage, if set.
///
/// Returns `None` if no fee collector has been configured, in which case the
/// withdraw path skips the fee transfer entirely.
pub fn get_fee_collector(env: &Env) -> Option<Address> {
    let val: Option<Address> = env.storage().instance().get(&FeeDataKey::FeeCollector);
    if val.is_some() {
        extend_instance_ttl(env);
    }
    val
}

// ── Public API: per-stream fee storage ───────────────────────────────────────

/// Writes the `fee_bps` for `stream_id` into persistent storage.
///
/// Called immediately after the stream row is created. The value must have been
/// validated via [`validate_fee_bps`] before calling this function.
///
/// If `fee_bps` is `0` (or equals the default) there is no value in writing the
/// entry, but it is written anyway for explicit auditability. Callers may skip
/// this if they only store non-default overrides (the `get_stream_fee_bps`
/// fallback handles missing entries).
pub fn set_stream_fee_bps(env: &Env, stream_id: u64, fee_bps: u32) {
    env.storage()
        .persistent()
        .set(&FeeDataKey::StreamFeeBps(stream_id), &fee_bps);
    extend_stream_fee_ttl(env, stream_id);
}

/// Returns the effective `fee_bps` for `stream_id`.
///
/// If no per-stream override exists, falls back to the global default from
/// [`get_default_fee_bps`]. This means streams created before the fee system
/// was deployed inherit the default (which is `0` unless explicitly set).
pub fn get_stream_fee_bps(env: &Env, stream_id: u64) -> u32 {
    let val: Option<u32> = env
        .storage()
        .persistent()
        .get(&FeeDataKey::StreamFeeBps(stream_id));
    if let Some(bps) = val {
        extend_stream_fee_ttl(env, stream_id);
        bps
    } else {
        get_default_fee_bps(env)
    }
}

// ── Public API: accumulated fee balance storage ───────────────────────────────

/// Adds `delta` to the accumulated fee balance for `stream_id`.
///
/// Called by the withdraw path each time a non-zero fee is charged.  The
/// running balance accumulates until the treasury sweep zeroes it via
/// [`clear_accumulated_fees`].
///
/// Uses checked arithmetic; returns [`Error::Overflow`] if the running total
/// would exceed `i128::MAX`.
///
/// # Errors
/// - [`Error::Overflow`] if `existing_balance + delta` would overflow `i128`.
pub fn accrue_fees(env: &Env, stream_id: u64, delta: i128) -> Result<(), Error> {
    if delta <= 0 {
        return Ok(());
    }
    let existing: i128 = env
        .storage()
        .persistent()
        .get(&FeeDataKey::AccumulatedFees(stream_id))
        .unwrap_or(0i128);
    let new_balance = existing.checked_add(delta).ok_or(Error::Overflow)?;
    env.storage()
        .persistent()
        .set(&FeeDataKey::AccumulatedFees(stream_id), &new_balance);
    extend_accum_fee_ttl(env, stream_id);
    Ok(())
}

/// Returns the accumulated (un-swept) fee balance for `stream_id`.
///
/// Returns `0` when no fees have been charged or the balance has already been
/// swept.  Extends the persistent storage TTL so the balance cannot archive
/// while the stream is active.
pub fn get_accumulated_fees(env: &Env, stream_id: u64) -> i128 {
    let val: Option<i128> = env
        .storage()
        .persistent()
        .get(&FeeDataKey::AccumulatedFees(stream_id));
    if val.is_some() {
        extend_accum_fee_ttl(env, stream_id);
    }
    val.unwrap_or(0i128)
}

/// Atomically zeroes the accumulated fee balance for `stream_id`.
///
/// Called by the sweep path **after** a successful token transfer to the fee
/// collector.  Clearing happens in a separate write to `0` (rather than a
/// `remove`) so the entry remains queryable after the sweep for audit
/// purposes.  A subsequent call to [`get_accumulated_fees`] will return `0`.
pub fn clear_accumulated_fees(env: &Env, stream_id: u64) {
    env.storage()
        .persistent()
        .set(&FeeDataKey::AccumulatedFees(stream_id), &0i128);
    extend_accum_fee_ttl(env, stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Contract;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.ledger().set_sequence_number(1_000);
        let contract_id = env.register(Contract, ());
        (env, contract_id)
    }

    // ── validate_fee_bps ──────────────────────────────────────────────────────

    /// A fee of exactly `MAX_FEE_BPS` (100 %) is the highest allowed value.
    #[test]
    fn validate_fee_bps_accepts_max() {
        assert!(validate_fee_bps(MAX_FEE_BPS).is_ok());
    }

    /// Any value strictly greater than `MAX_FEE_BPS` is rejected.
    #[test]
    fn validate_fee_bps_rejects_above_max() {
        let result = validate_fee_bps(MAX_FEE_BPS + 1);
        assert_eq!(result, Err(Error::InvalidFeeBps));
    }

    /// `0` is always valid — it means no fee.
    #[test]
    fn validate_fee_bps_accepts_zero() {
        assert!(validate_fee_bps(0).is_ok());
    }

    /// Representative in-range values are accepted.
    #[test]
    fn validate_fee_bps_accepts_typical_values() {
        for bps in [1u32, 50, 100, 500, 1_000, 5_000, 9_999, 10_000] {
            assert!(
                validate_fee_bps(bps).is_ok(),
                "expected Ok for fee_bps = {bps}"
            );
        }
    }

    // ── apply_fee ─────────────────────────────────────────────────────────────

    /// Zero fee always returns the full amount as net with zero fee.
    #[test]
    fn apply_fee_zero_bps_is_identity() {
        let result = apply_fee(1_000_000, 0).unwrap();
        assert_eq!(result.fee_amount, 0);
        assert_eq!(result.net_amount, 1_000_000);
    }

    /// A zero amount is always a no-op regardless of bps.
    #[test]
    fn apply_fee_zero_amount_is_noop() {
        let result = apply_fee(0, 500).unwrap();
        assert_eq!(result.fee_amount, 0);
        assert_eq!(result.net_amount, 0);
    }

    /// 1 % fee on 1 000 tokens → 10 fee, 990 net.
    #[test]
    fn apply_fee_one_percent() {
        let result = apply_fee(1_000, 100).unwrap();
        assert_eq!(result.fee_amount, 10);
        assert_eq!(result.net_amount, 990);
    }

    /// 5 % fee on 10 000 tokens → 500 fee, 9 500 net.
    #[test]
    fn apply_fee_five_percent() {
        let result = apply_fee(10_000, 500).unwrap();
        assert_eq!(result.fee_amount, 500);
        assert_eq!(result.net_amount, 9_500);
    }

    /// 100 % fee (10 000 bps) sends everything to the fee collector.
    #[test]
    fn apply_fee_full_hundred_percent() {
        let result = apply_fee(1_000, MAX_FEE_BPS).unwrap();
        assert_eq!(result.fee_amount, 1_000);
        assert_eq!(result.net_amount, 0);
    }

    /// Fee and net amount must always sum back to the original amount.
    #[test]
    fn apply_fee_amounts_sum_to_original() {
        for (amount, bps) in [
            (1, 1),
            (999, 100),
            (1_000_000, 333),
            (i128::MAX / 10_001, 9_999),
        ] {
            let r = apply_fee(amount, bps).unwrap();
            assert_eq!(
                r.fee_amount + r.net_amount,
                amount,
                "sum mismatch for amount={amount} bps={bps}"
            );
        }
    }

    /// Overflow is detected and `Error::Overflow` is returned instead of
    /// panicking or silently wrapping.
    #[test]
    fn apply_fee_overflow_returns_error() {
        // i128::MAX * 1 / 10_000 is fine, but i128::MAX * 10_000 overflows.
        let result = apply_fee(i128::MAX, MAX_FEE_BPS);
        assert_eq!(result, Err(Error::Overflow));
    }

    /// Floor division: 1 bps on 9 tokens (= 0.0009) should give fee_amount = 0.
    #[test]
    fn apply_fee_floor_division() {
        let result = apply_fee(9, 1).unwrap(); // 9 * 1 / 10_000 = 0 (floor)
        assert_eq!(result.fee_amount, 0);
        assert_eq!(result.net_amount, 9);
    }

    // ── default fee storage ───────────────────────────────────────────────────

    /// Default fee is `0` when no value has been set.
    #[test]
    fn get_default_fee_bps_returns_zero_when_unset() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert_eq!(get_default_fee_bps(&env), 0);
        });
    }

    /// `set_default_fee_bps` persists and `get_default_fee_bps` retrieves it.
    #[test]
    fn set_and_get_default_fee_bps_roundtrip() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_default_fee_bps(&env, 200);
            assert_eq!(get_default_fee_bps(&env), 200);
        });
    }

    /// Overwriting the default fee is idempotent.
    #[test]
    fn set_default_fee_bps_overwrite() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_default_fee_bps(&env, 100);
            set_default_fee_bps(&env, 300);
            assert_eq!(get_default_fee_bps(&env), 300);
        });
    }

    // ── fee collector storage ─────────────────────────────────────────────────

    /// Returns `None` when no fee collector has been configured.
    #[test]
    fn get_fee_collector_returns_none_when_unset() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert!(get_fee_collector(&env).is_none());
        });
    }

    /// `set_fee_collector` persists and `get_fee_collector` retrieves it.
    #[test]
    fn set_and_get_fee_collector_roundtrip() {
        let (env, contract_id) = setup();
        let collector = Address::generate(&env);
        env.as_contract(&contract_id, || {
            set_fee_collector(&env, &collector);
            assert_eq!(get_fee_collector(&env), Some(collector));
        });
    }

    /// The fee collector can be replaced.
    #[test]
    fn set_fee_collector_overwrites_previous() {
        let (env, contract_id) = setup();
        let c1 = Address::generate(&env);
        let c2 = Address::generate(&env);
        env.as_contract(&contract_id, || {
            set_fee_collector(&env, &c1);
            set_fee_collector(&env, &c2);
            assert_eq!(get_fee_collector(&env), Some(c2));
        });
    }

    // ── per-stream fee storage ────────────────────────────────────────────────

    /// Returns the global default when no per-stream override is written.
    #[test]
    fn get_stream_fee_bps_falls_back_to_default() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_default_fee_bps(&env, 50);
            assert_eq!(get_stream_fee_bps(&env, 42), 50);
        });
    }

    /// Returns `0` when no override and no default has been set.
    #[test]
    fn get_stream_fee_bps_returns_zero_for_completely_unset_stream() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert_eq!(get_stream_fee_bps(&env, 1), 0);
        });
    }

    /// A per-stream override takes precedence over the global default.
    #[test]
    fn set_stream_fee_bps_overrides_default() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_default_fee_bps(&env, 100);
            set_stream_fee_bps(&env, 7, 250);
            assert_eq!(get_stream_fee_bps(&env, 7), 250);
            // Stream 8 has no override → still returns the default.
            assert_eq!(get_stream_fee_bps(&env, 8), 100);
        });
    }

    /// Writing `0` as a per-stream override is explicit and should be respected
    /// (it means "no fee regardless of the global default").
    #[test]
    fn set_stream_fee_bps_zero_overrides_non_zero_default() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_default_fee_bps(&env, 500);
            set_stream_fee_bps(&env, 3, 0);
            assert_eq!(get_stream_fee_bps(&env, 3), 0);
        });
    }
}
