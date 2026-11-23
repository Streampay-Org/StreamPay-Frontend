//! # Snapshot diff for payment streams
//!
//! A **snapshot** is a point-in-time capture of a stream's financial state at
//! a specific ledger timestamp. A **diff** is the computed delta between two
//! such snapshots, expressing exactly how much has vested, been released, and
//! remains locked between the two observation points.
//!
//! ## Typical usage
//!
//! ```ignore
//! // Capture state at two different ledger timestamps
//! let snap_a = Contract::stream_snapshot(&env, stream_id, timestamp_a);
//! let snap_b = Contract::stream_snapshot(&env, stream_id, timestamp_b);
//!
//! // Compute the diff (b relative to a)
//! let diff = Contract::diff_snapshots(&env, snap_a, snap_b)?;
//! ```
//!
//! ## Design
//!
//! - **Read-only**: No state mutation, no auth required.
//! - **Overflow-safe**: All arithmetic uses checked operations; any overflow
//!   propagates as [`crate::Error::Overflow`].
//! - **No `unwrap` / `expect` / `panic`**: Complies with the workspace lint
//!   policy (`deny(unwrap_used, expect_used, panic)`).
//! - **Cross-stream diffs are rejected**: Both snapshots must reference the
//!   same `stream_id` to prevent nonsensical comparisons.

use crate::{release, storage, Error, Stream, StreamStatus};
use soroban_sdk::{contracttype, Env};

// ── Public types ──────────────────────────────────────────────────────────────

/// A point-in-time capture of a stream's financial state.
///
/// Snapshots are created by [`stream_snapshot`] at a caller-supplied ledger
/// timestamp. They are cheap value types (all fields are scalars) and are
/// intended to be stored off-chain or passed as arguments to
/// [`diff_snapshots`].
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct StreamSnapshot {
    /// The stream this snapshot was taken from.
    pub stream_id: u64,
    /// The ledger timestamp at which the snapshot was taken.
    pub timestamp: u64,
    /// Amount that had vested at `timestamp` (includes already-released funds).
    pub vested_amount: i128,
    /// Amount that had been released (withdrawn) up to `timestamp`.
    pub released_amount: i128,
    /// Amount still locked in escrow at `timestamp`
    /// (`total_amount - released_amount`).
    pub locked_amount: i128,
    /// Amount available for withdrawal at `timestamp`
    /// (`vested_amount - released_amount`).
    pub withdrawable_amount: i128,
    /// Stream status at `timestamp`.
    pub status: StreamStatus,
}

/// The computed delta between two [`StreamSnapshot`]s.
///
/// All `delta_*` fields express **`after − before`**, so positive values
/// indicate growth and negative values indicate a decrease (e.g. after a
/// large withdrawal the `delta_locked` will be negative).
///
/// Both snapshots must reference the same `stream_id`; passing mismatched
/// snapshots returns [`Error::NotFound`].
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SnapshotDiff {
    /// Stream the diff belongs to.
    pub stream_id: u64,
    /// Timestamp of the earlier snapshot (`before`).
    pub from_timestamp: u64,
    /// Timestamp of the later snapshot (`after`).
    pub to_timestamp: u64,
    /// How much additional vesting occurred between the two snapshots.
    /// Always `>= 0` for non-decreasing vesting; can be `0` while paused.
    pub delta_vested: i128,
    /// Net change in released (withdrawn) amount. `>= 0` because tokens can
    /// only be released, never un-released.
    pub delta_released: i128,
    /// Net change in locked escrow balance. Typically `<= 0` as funds leave
    /// escrow via withdrawal or settlement.
    pub delta_locked: i128,
    /// Net change in the withdrawable balance.
    pub delta_withdrawable: i128,
    /// Elapsed wall-clock seconds between `from_timestamp` and `to_timestamp`.
    pub elapsed_seconds: u64,
    /// Status at the `before` snapshot.
    pub status_before: StreamStatus,
    /// Status at the `after` snapshot.
    pub status_after: StreamStatus,
}

// ── Core logic ────────────────────────────────────────────────────────────────

/// Captures a [`StreamSnapshot`] for `stream_id` at `at_timestamp`.
///
/// The function loads the live stream record and evaluates the linear-accrual
/// math at the supplied timestamp. Passing the current ledger timestamp
/// (`env.ledger().timestamp()`) gives the live snapshot; passing a historical
/// timestamp gives a retroactive view of the stream's state at that point.
///
/// # Parameters
/// - `env`          — Soroban execution environment.
/// - `stream_id`    — Numeric ID of the stream to snapshot.
/// - `at_timestamp` — Ledger timestamp to evaluate accrual at.
///
/// # Returns
/// A [`StreamSnapshot`] containing all financials at `at_timestamp`.
///
/// # Errors
/// - [`Error::NotFound`]  if `stream_id` does not exist in storage.
/// - [`Error::Overflow`]  if any arithmetic step overflows `i128`.
pub fn stream_snapshot(
    env: &Env,
    stream_id: u64,
    at_timestamp: u64,
) -> Result<StreamSnapshot, Error> {
    let stream = get_stream(env, stream_id)?;
    snapshot_from_stream(&stream, at_timestamp)
}

/// Computes the delta between two [`StreamSnapshot`]s.
///
/// `before` and `after` must reference the same `stream_id`. If they do not,
/// [`Error::NotFound`] is returned. The ordering of timestamps is not enforced
/// (callers may pass them in any order), but by convention `before.timestamp
/// <= after.timestamp` yields non-negative `delta_vested` and `delta_released`.
///
/// # Parameters
/// - `_env`   — Soroban execution environment (reserved for future use).
/// - `before` — Snapshot at the earlier point in time.
/// - `after`  — Snapshot at the later point in time.
///
/// # Returns
/// A [`SnapshotDiff`] containing the field-by-field deltas.
///
/// # Errors
/// - [`Error::NotFound`] if the two snapshots reference different stream IDs.
/// - [`Error::Overflow`] if any arithmetic step overflows `i128` or `u64`.
pub fn diff_snapshots(
    _env: &Env,
    before: &StreamSnapshot,
    after: &StreamSnapshot,
) -> Result<SnapshotDiff, Error> {
    if before.stream_id != after.stream_id {
        return Err(Error::NotFound);
    }

    let delta_vested = after
        .vested_amount
        .checked_sub(before.vested_amount)
        .ok_or(Error::Overflow)?;

    let delta_released = after
        .released_amount
        .checked_sub(before.released_amount)
        .ok_or(Error::Overflow)?;

    let delta_locked = after
        .locked_amount
        .checked_sub(before.locked_amount)
        .ok_or(Error::Overflow)?;

    let delta_withdrawable = after
        .withdrawable_amount
        .checked_sub(before.withdrawable_amount)
        .ok_or(Error::Overflow)?;

    // Absolute difference: always non-negative regardless of which snapshot is
    // "before" and which is "after" (callers may pass them in any order).
    let elapsed_seconds = if after.timestamp >= before.timestamp {
        after.timestamp.saturating_sub(before.timestamp)
    } else {
        before.timestamp.saturating_sub(after.timestamp)
    };

    Ok(SnapshotDiff {
        stream_id: before.stream_id,
        from_timestamp: before.timestamp,
        to_timestamp: after.timestamp,
        delta_vested,
        delta_released,
        delta_locked,
        delta_withdrawable,
        elapsed_seconds,
        status_before: before.status.clone(),
        status_after: after.status.clone(),
    })
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Loads a stream from storage, returning [`Error::NotFound`] if absent.
fn get_stream(env: &Env, stream_id: u64) -> Result<Stream, Error> {
    storage::get_stream(env, stream_id).ok_or(Error::NotFound)
}

/// Builds a [`StreamSnapshot`] from a loaded [`Stream`] at `at_timestamp`.
fn snapshot_from_stream(stream: &Stream, at_timestamp: u64) -> Result<StreamSnapshot, Error> {
    let vested = release::vested_amount(stream, at_timestamp)?;
    let withdrawable = release::withdrawable(stream, at_timestamp)?;

    let locked = stream
        .total_amount
        .checked_sub(stream.released_amount)
        .ok_or(Error::Overflow)?;

    Ok(StreamSnapshot {
        stream_id: stream.id,
        timestamp: at_timestamp,
        vested_amount: vested,
        released_amount: stream.released_amount,
        locked_amount: locked,
        withdrawable_amount: withdrawable,
        status: stream.status.clone(),
    })
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::StreamStatus;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    /// Build a minimal [`Stream`] for unit-testing snapshot math without
    /// touching real contract storage.
    fn make_stream(
        env: &Env,
        total_amount: i128,
        released_amount: i128,
        start_time: u64,
        end_time: u64,
        status: StreamStatus,
        paused_at: u64,
        total_paused_duration: u64,
    ) -> Stream {
        let addr = Address::generate(env);
        let duration = end_time.saturating_sub(start_time);
        Stream {
            id: 1,
            sender: addr.clone(),
            recipient: addr.clone(),
            token: addr,
            total_amount,
            released_amount,
            start_time,
            end_time,
            duration,
            last_update: start_time,
            status,
            paused_at,
            total_paused_duration,
            fee_bps: 0,
        }
    }

    // ── snapshot_from_stream ──────────────────────────────────────────────────

    #[test]
    fn snapshot_draft_stream_has_zero_vested() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 100, 200, StreamStatus::Draft, 0, 0);
        let snap = snapshot_from_stream(&stream, 150).unwrap();
        assert_eq!(snap.vested_amount, 0);
        assert_eq!(snap.released_amount, 0);
        assert_eq!(snap.locked_amount, 1_000);
        assert_eq!(snap.withdrawable_amount, 0);
        assert_eq!(snap.status, StreamStatus::Draft);
        assert_eq!(snap.stream_id, 1);
        assert_eq!(snap.timestamp, 150);
    }

    #[test]
    fn snapshot_active_at_midpoint() {
        let env = Env::default();
        // 1000 tokens over 200s, snapshot at t=200 (midpoint of 100..300)
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        assert_eq!(snap.vested_amount, 500);
        assert_eq!(snap.released_amount, 0);
        assert_eq!(snap.locked_amount, 1_000);
        assert_eq!(snap.withdrawable_amount, 500);
    }

    #[test]
    fn snapshot_active_fully_vested() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 400).unwrap();
        assert_eq!(snap.vested_amount, 1_000);
        assert_eq!(snap.withdrawable_amount, 1_000);
    }

    #[test]
    fn snapshot_partial_release_reduces_withdrawable() {
        let env = Env::default();
        // Already released 300 of 1000; at midpoint vested=500, withdrawable=200
        let stream = make_stream(&env, 1_000, 300, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        assert_eq!(snap.vested_amount, 500);
        assert_eq!(snap.released_amount, 300);
        assert_eq!(snap.withdrawable_amount, 200);
        assert_eq!(snap.locked_amount, 700); // total - released
    }

    #[test]
    fn snapshot_paused_stream_accrual_frozen() {
        let env = Env::default();
        // Paused at t=150; snapshot taken at t=200 should reflect t=150 accrual
        // 1000 tokens, 100..300 → vested at 150 = 250
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Paused, 150, 0);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        assert_eq!(snap.vested_amount, 250);
        assert_eq!(snap.withdrawable_amount, 250);
        assert_eq!(snap.status, StreamStatus::Paused);
    }

    #[test]
    fn snapshot_at_start_time_zero_vested() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 100).unwrap();
        assert_eq!(snap.vested_amount, 0);
        assert_eq!(snap.withdrawable_amount, 0);
    }

    #[test]
    fn snapshot_before_start_time_zero_vested() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 50).unwrap();
        assert_eq!(snap.vested_amount, 0);
    }

    #[test]
    fn snapshot_settled_stream() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 1_000, 100, 300, StreamStatus::Settled, 0, 0);
        let snap = snapshot_from_stream(&stream, 350).unwrap();
        assert_eq!(snap.released_amount, 1_000);
        assert_eq!(snap.locked_amount, 0);
        assert_eq!(snap.status, StreamStatus::Settled);
    }

    #[test]
    fn snapshot_cancelled_stream() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 400, 100, 300, StreamStatus::Cancelled, 0, 0);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        assert_eq!(snap.released_amount, 400);
        assert_eq!(snap.locked_amount, 600);
        assert_eq!(snap.status, StreamStatus::Cancelled);
    }

    #[test]
    fn snapshot_with_paused_duration_excluded() {
        let env = Env::default();
        // 1000 tokens, 100..300 (200s duration), 50s total_paused_duration
        // At t=200: elapsed = (200-100) - 50 = 50; vested = 1000*50/200 = 250
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 50);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        assert_eq!(snap.vested_amount, 250);
    }

    // ── diff_snapshots ────────────────────────────────────────────────────────

    #[test]
    fn diff_same_snapshots_all_zero_deltas() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 100, 300, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 200).unwrap();
        let diff = diff_snapshots(&env, &snap, &snap).unwrap();
        assert_eq!(diff.delta_vested, 0);
        assert_eq!(diff.delta_released, 0);
        assert_eq!(diff.delta_locked, 0);
        assert_eq!(diff.delta_withdrawable, 0);
        assert_eq!(diff.elapsed_seconds, 0);
    }

    #[test]
    fn diff_forward_in_time_positive_delta_vested() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream, 100).unwrap(); // vested=100
        let snap_b = snapshot_from_stream(&stream, 600).unwrap(); // vested=600
        let diff = diff_snapshots(&env, &snap_a, &snap_b).unwrap();
        assert_eq!(diff.delta_vested, 500);
        assert_eq!(diff.elapsed_seconds, 500);
        assert_eq!(diff.from_timestamp, 100);
        assert_eq!(diff.to_timestamp, 600);
        assert_eq!(diff.stream_id, 1);
    }

    #[test]
    fn diff_after_withdrawal_delta_released_positive() {
        let env = Env::default();
        // snap_a: no release; snap_b: 400 released
        let stream_a = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream_a, 500).unwrap();

        let stream_b = make_stream(&env, 1_000, 400, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_b = StreamSnapshot {
            stream_id: 1,
            released_amount: 400,
            ..snapshot_from_stream(&stream_b, 500).unwrap()
        };

        let diff = diff_snapshots(&env, &snap_a, &snap_b).unwrap();
        assert_eq!(diff.delta_released, 400);
        assert_eq!(diff.delta_locked, -400);
    }

    #[test]
    fn diff_mismatched_stream_ids_returns_not_found() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream, 100).unwrap();
        let snap_b = StreamSnapshot {
            stream_id: 99, // different stream
            ..snapshot_from_stream(&stream, 200).unwrap()
        };
        let result = diff_snapshots(&env, &snap_a, &snap_b);
        assert_eq!(result, Err(Error::NotFound));
    }

    #[test]
    fn diff_elapsed_seconds_is_abs_when_reversed() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream, 100).unwrap();
        let snap_b = snapshot_from_stream(&stream, 600).unwrap();
        // Pass in reverse order (after, before)
        let diff = diff_snapshots(&env, &snap_b, &snap_a).unwrap();
        assert_eq!(diff.elapsed_seconds, 500);
    }

    #[test]
    fn diff_status_transition_recorded() {
        let env = Env::default();
        let stream_active = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_before = snapshot_from_stream(&stream_active, 100).unwrap();

        let stream_paused = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Paused, 300, 0);
        let snap_after = StreamSnapshot {
            stream_id: 1,
            status: StreamStatus::Paused,
            ..snapshot_from_stream(&stream_paused, 300).unwrap()
        };

        let diff = diff_snapshots(&env, &snap_before, &snap_after).unwrap();
        assert_eq!(diff.status_before, StreamStatus::Active);
        assert_eq!(diff.status_after, StreamStatus::Paused);
    }

    #[test]
    fn diff_fully_vested_then_settled() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 500, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream, 250).unwrap(); // halfway, locked=1000

        let stream_settled = make_stream(&env, 1_000, 1_000, 0, 500, StreamStatus::Settled, 0, 0);
        let snap_b = StreamSnapshot {
            stream_id: 1,
            status: StreamStatus::Settled,
            released_amount: 1_000,
            locked_amount: 0, // total - released = 1000 - 1000
            withdrawable_amount: 0,
            ..snapshot_from_stream(&stream_settled, 600).unwrap()
        };

        let diff = diff_snapshots(&env, &snap_a, &snap_b).unwrap();
        assert_eq!(diff.delta_released, 1_000); // 1000 - 0
        assert_eq!(diff.delta_locked, -1_000); // 0 - 1000
        assert_eq!(diff.status_before, StreamStatus::Active);
        assert_eq!(diff.status_after, StreamStatus::Settled);
    }

    #[test]
    fn snapshot_zero_elapsed_no_vesting() {
        let env = Env::default();
        // snapshot at exactly start time
        let stream = make_stream(&env, 5_000, 0, 1_000, 2_000, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 1_000).unwrap();
        assert_eq!(snap.vested_amount, 0);
        assert_eq!(snap.withdrawable_amount, 0);
        assert_eq!(snap.locked_amount, 5_000);
    }

    #[test]
    fn diff_delta_withdrawable_decreases_after_withdrawal() {
        let env = Env::default();
        // Before: 500 vested, 0 released → withdrawable=500
        let stream_before = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream_before, 500).unwrap();

        // After: 500 vested, 500 released → withdrawable=0
        let stream_after = make_stream(&env, 1_000, 500, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_b = StreamSnapshot {
            stream_id: 1,
            timestamp: 500,
            ..snapshot_from_stream(&stream_after, 500).unwrap()
        };

        let diff = diff_snapshots(&env, &snap_a, &snap_b).unwrap();
        assert_eq!(diff.delta_withdrawable, -500);
        assert_eq!(diff.delta_released, 500);
        assert_eq!(diff.elapsed_seconds, 0);
    }

    #[test]
    fn snapshot_large_amounts_no_overflow() {
        let env = Env::default();
        // Use amounts near i128::MAX / 2 to test overflow safety
        let large = i128::MAX / 4;
        let stream = make_stream(&env, large, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 500).unwrap();
        // Should compute without panicking; vested ~ large/2
        assert!(snap.vested_amount > 0);
        assert!(snap.vested_amount <= large);
    }

    #[test]
    fn diff_both_timestamps_zero() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap = snapshot_from_stream(&stream, 0).unwrap();
        let diff = diff_snapshots(&env, &snap.clone(), &snap).unwrap();
        assert_eq!(diff.elapsed_seconds, 0);
        assert_eq!(diff.delta_vested, 0);
    }

    #[test]
    fn diff_stream_ids_match_is_preserved() {
        let env = Env::default();
        let stream = make_stream(&env, 1_000, 0, 0, 1_000, StreamStatus::Active, 0, 0);
        let snap_a = snapshot_from_stream(&stream, 100).unwrap();
        let snap_b = snapshot_from_stream(&stream, 500).unwrap();
        let diff = diff_snapshots(&env, &snap_a, &snap_b).unwrap();
        assert_eq!(diff.stream_id, stream.id);
    }
}
