//! # Linear release/accrual math
//!
//! Pure functions for computing vested amounts in a payment stream using
//! overflow-safe checked arithmetic. All arithmetic uses checked operations
//! that propagate [`Error::Overflow`] instead of panicking, making the
//! contract safe for production use even with extreme inputs.
//!
//! The contract's `Cargo.toml` sets `overflow-checks = true`, but these
//! functions explicitly use checked operations to guarantee safety at the
//! type level and make the invariants clear to reviewers.

use super::{Error, Milestone, ReleaseCurve, Stream, StreamStatus, MAX_MILESTONES};
use core::cmp::{max, min};
use soroban_sdk::Vec;

/// Basis-point denominator representing 100%.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Validates a milestone release schedule against `[start_time, end_time]`.
///
/// Rules:
/// - Must contain between `1` and [`MAX_MILESTONES`] (inclusive) entries.
/// - `time` must be strictly increasing and within `[start_time, end_time]`.
/// - `cumulative_bps` must be non-decreasing, at most `10_000`, and the final
///   milestone must have `cumulative_bps == 10_000`.
///
/// # Errors
/// Returns [`Error::InvalidSchedule`] if any rule is violated.
pub fn validate_milestones(
    milestones: &Vec<Milestone>,
    start_time: u64,
    end_time: u64,
) -> Result<(), Error> {
    let len = milestones.len();
    if len == 0 || len > MAX_MILESTONES {
        return Err(Error::InvalidSchedule);
    }

    let mut prev_time: Option<u64> = None;
    let mut prev_bps: u32 = 0;

    for m in milestones.iter() {
        if m.time < start_time || m.time > end_time {
            return Err(Error::InvalidSchedule);
        }
        if let Some(pt) = prev_time {
            if m.time <= pt {
                return Err(Error::InvalidSchedule);
            }
        }
        if m.cumulative_bps < prev_bps || m.cumulative_bps > BPS_DENOMINATOR {
            return Err(Error::InvalidSchedule);
        }
        prev_time = Some(m.time);
        prev_bps = m.cumulative_bps;
    }

    if prev_bps != BPS_DENOMINATOR {
        return Err(Error::InvalidSchedule);
    }

    Ok(())
}

/// Computes the total amount that has vested at a given ledger timestamp.
///
/// Accounts for paused duration: time "stops" while the stream is paused.
/// Supports both [`ReleaseCurve::Linear`] and [`ReleaseCurve::Milestones`].
///
/// ## Cliff semantics
///
/// When `stream.cliff_time > 0`, vesting is withheld (`0`) until the active
/// elapsed time reaches `cliff_time - start_time`. At and after the cliff,
/// vesting jumps to the full linear amount for the elapsed time
/// (`total_amount * elapsed / duration`) and still reaches `total_amount` at
/// `end_time`. Because the cliff threshold is evaluated against `elapsed`
/// (which already excludes paused time), pausing across the cliff shifts the
/// effective cliff date by the paused duration in lockstep with `end_time`.
///
/// # Returns
///
/// * `Ok(vested)` — the vested amount, always in `[0, total_amount]`.
/// * `Err(Error::Overflow)` — if any arithmetic step overflows `i128`.
pub fn vested_amount(stream: &Stream, now: u64) -> Result<i128, Error> {
    if stream.status == StreamStatus::Draft {
        return Ok(0);
    }

    // Nothing vests before the stream's start_time (even if a milestone sits
    // at start_time).
    if now < stream.start_time {
        return Ok(0);
    }

    // Clamp now to [start_time, end_time]
    let mut effective_now = max(stream.start_time, min(now, stream.end_time));

    // If currently paused, accrual stopped at paused_at
    if stream.status == StreamStatus::Paused {
        if stream.paused_at < stream.start_time {
            return Ok(0);
        }
        effective_now = min(effective_now, stream.paused_at);
    }

    // Compute elapsed time since start, excluding paused time
    let elapsed = effective_now
        .saturating_sub(stream.start_time)
        .saturating_sub(stream.total_paused_duration);

    // If a cliff is configured, nothing vests until active elapsed time
    // reaches `cliff_time - start_time`.
    if stream.cliff_time > 0 {
        let cliff_elapsed = stream.cliff_time.saturating_sub(stream.start_time);
        if elapsed < cliff_elapsed {
            return Ok(0);
        }
    }

    // If stream duration has fully elapsed, total amount is fully vested
    if stream.duration == 0 || elapsed >= stream.duration {
        return Ok(stream.total_amount);
    }

    match &stream.curve {
        ReleaseCurve::Linear => {
            // vested = total_amount * elapsed / duration
            // All casts from u64 to i128 are safe because u64::MAX < i128::MAX.
            stream
                .total_amount
                .checked_mul(i128::from(elapsed)) // total_amount ∈ [0, i128::MAX], elapsed cast is lossless
                .ok_or(Error::Overflow)? // propagate overflow
                .checked_div(i128::from(stream.duration)) // duration > 0 at this point, cast is lossless
                .ok_or(Error::Overflow) // propagate overflow (shouldn't happen for division by non-zero)
        }
        ReleaseCurve::Milestones(milestones) => {
            // Effective schedule timestamp accounting for pauses.
            let effective_time = stream.start_time.saturating_add(elapsed);

            let mut cumulative_bps: u32 = 0;
            for m in milestones.iter() {
                if m.time <= effective_time {
                    cumulative_bps = m.cumulative_bps;
                } else {
                    break;
                }
            }

            if cumulative_bps == 0 {
                return Ok(0);
            }
            if cumulative_bps >= BPS_DENOMINATOR {
                return Ok(stream.total_amount);
            }

            stream
                .total_amount
                .checked_mul(i128::from(cumulative_bps))
                .ok_or(Error::Overflow)?
                .checked_div(i128::from(BPS_DENOMINATOR))
                .ok_or(Error::Overflow)
        }
    }
}

/// Computes the amount available for withdrawal (vested - already released).
///
/// # Returns
///
/// * `Ok(available)` — non-negative withdrawable amount.
/// * `Err(Error::Overflow)` — if the vested-amount calculation overflows.
pub fn withdrawable(stream: &Stream, now: u64) -> Result<i128, Error> {
    let vested = vested_amount(stream, now)?;
    let available = vested.saturating_sub(stream.released_amount);

    // Defensive clamp to ensure non-negative (should already be guaranteed
    // by saturating_sub, but we keep this for readability).
    Ok(max(0, available))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StreamStatus;
    use soroban_sdk::{testutils::Address as _, Address};

    /// Helper to create a test stream. Uses a shared `Env` so that
    /// `Address::generate` (which lives in `soroban_sdk::testutils`)
    /// resolves at compile time.
    fn test_stream(
        total_amount: i128,
        released_amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Stream {
        let env = soroban_sdk::Env::default();
        Stream {
            id: 1,
            sender: Address::generate(&env),
            recipient: Address::generate(&env),
            token: Address::generate(&env),
            total_amount,
            released_amount,
            start_time,
            end_time,
            duration: end_time - start_time,
            last_update: start_time,
            status: StreamStatus::Active,
            paused_at: 0,
            total_paused_duration: 0,
            fee_bps: 0,
            cliff_time: 0,
            curve: ReleaseCurve::Linear,
        }
    }

    #[test]
    fn test_vested_amount_at_start() {
        let stream = test_stream(1000, 0, 1000, 2000);
        assert_eq!(vested_amount(&stream, 1000), Ok(0));
    }

    #[test]
    fn test_vested_amount_at_midpoint() {
        let stream = test_stream(1000, 0, 1000, 2000);
        assert_eq!(vested_amount(&stream, 1500), Ok(500));
    }

    #[test]
    fn test_vested_amount_at_end() {
        let stream = test_stream(1000, 0, 1000, 2000);
        assert_eq!(vested_amount(&stream, 2000), Ok(1000));
    }

    #[test]
    fn test_vested_amount_past_end() {
        let stream = test_stream(1000, 0, 1000, 2000);
        assert_eq!(vested_amount(&stream, 3000), Ok(1000));
    }

    #[test]
    fn test_vested_amount_before_start() {
        let stream = test_stream(1000, 0, 1000, 2000);
        assert_eq!(vested_amount(&stream, 500), Ok(0));
    }

    #[test]
    fn test_vested_amount_clamped_to_total() {
        let stream = test_stream(1000, 0, 1000, 2000);
        // Even with very large now, should not exceed total_amount
        assert_eq!(vested_amount(&stream, u64::MAX), Ok(1000));
    }

    #[test]
    fn test_vested_amount_never_negative() {
        let stream = test_stream(1000, 0, 1000, 2000);
        let v0 = vested_amount(&stream, 0).unwrap();
        let v500 = vested_amount(&stream, 500).unwrap();
        let v1000 = vested_amount(&stream, 1000).unwrap();
        assert!(v0 >= 0);
        assert!(v500 >= 0);
        assert!(v1000 >= 0);
    }

    #[test]
    fn test_vested_amount_monotonic() {
        let stream = test_stream(1000, 0, 1000, 2000);
        let v1 = vested_amount(&stream, 1200).unwrap();
        let v2 = vested_amount(&stream, 1400).unwrap();
        let v3 = vested_amount(&stream, 1600).unwrap();
        assert!(v1 <= v2 && v2 <= v3);
    }

    #[test]
    fn test_withdrawable_basic() {
        let stream = test_stream(1000, 200, 1000, 2000);
        assert_eq!(withdrawable(&stream, 1000), Ok(0));
        assert_eq!(withdrawable(&stream, 1500), Ok(300));
        assert_eq!(withdrawable(&stream, 2000), Ok(800));
    }

    #[test]
    fn test_withdrawable_never_negative() {
        let stream = test_stream(1000, 500, 1000, 2000);
        // Even with released_amount > vested, should not be negative
        let w1000 = withdrawable(&stream, 1000).unwrap();
        let w1200 = withdrawable(&stream, 1200).unwrap();
        assert!(w1000 >= 0);
        assert!(w1200 >= 0);
    }

    #[test]
    fn test_withdrawable_fully_withdrawn() {
        let stream = test_stream(1000, 1000, 1000, 2000);
        assert_eq!(withdrawable(&stream, 2000), Ok(0));
    }

    #[test]
    fn test_large_amount_near_i128_max() {
        // Use a large amount that could cause overflow if not using
        // checked arithmetic. We pick a value whose product with the
        // duration still fits in i128: i128::MAX / 1000 ensures
        // amount * duration is well under i128::MAX.
        let large_amount = i128::MAX / 1000;
        let stream = test_stream(large_amount, 0, 1000, 2000);
        let vested = vested_amount(&stream, 1500).unwrap();
        assert!(vested >= 0 && vested <= large_amount);
        assert_eq!(vested, large_amount / 2);
    }

    /// Verify that an extreme `total_amount` whose product with elapsed
    /// overflows `i128` yields `Err(Error::Overflow)` instead of panicking.
    #[test]
    fn test_overflow_propagates_on_extreme_input() {
        let stream = test_stream(i128::MAX, 0, 0, 1000);
        // elapsed = 500, duration = 1000
        // i128::MAX * 500 overflows i128
        let result = vested_amount(&stream, 500);
        assert_eq!(result, Err(Error::Overflow));
    }

    #[test]
    fn test_zero_duration_edge_case() {
        // This should not happen in practice, but we handle it
        // defensively.
        let mut stream = test_stream(1000, 0, 1000, 1000);
        stream.duration = 0;
        assert_eq!(vested_amount(&stream, 1000), Ok(1000));
    }

    #[test]
    fn test_table_driven_vested_amount() {
        // (total, start, end, now, expected)
        let cases: [(i128, u64, u64, u64, i128); 12] = [
            (1000, 1000, 2000, 500, 0),     // before start
            (1000, 1000, 2000, 1000, 0),    // at start
            (1000, 1000, 2000, 1250, 250),  // 25% through
            (1000, 1000, 2000, 1500, 500),  // 50% through
            (1000, 1000, 2000, 1750, 750),  // 75% through
            (1000, 1000, 2000, 2000, 1000), // at end
            (1000, 1000, 2000, 3000, 1000), // past end
            (100, 0, 100, 0, 0),            // zero start time
            (100, 0, 100, 50, 50),          // zero start time, mid
            (100, 0, 100, 100, 100),        // zero start time, at end
            (1, 0, 1, 0, 0),                // minimal duration
            (1, 0, 1, 1, 1),                // minimal duration, at end
        ];

        for case in &cases {
            let stream = test_stream(case.0, 0, case.1, case.2);
            let result = vested_amount(&stream, case.3);
            assert_eq!(
                result,
                Ok(case.4),
                "vested_amount failed: total={}, start={}, end={}, now={}, expected={}, got={:?}",
                case.0,
                case.1,
                case.2,
                case.3,
                case.4,
                result
            );
        }
    }

    #[test]
    fn test_table_driven_withdrawable() {
        // (total, released, start, end, now, expected)
        let cases: [(i128, i128, u64, u64, u64, i128); 6] = [
            (1000, 0, 1000, 2000, 1000, 0),     // nothing vested
            (1000, 0, 1000, 2000, 1500, 500),   // half vested
            (1000, 200, 1000, 2000, 1500, 300), // half vested, some released
            (1000, 500, 1000, 2000, 1500, 0),   // half vested, more released
            (1000, 1000, 1000, 2000, 2000, 0),  // fully released
            (1000, 0, 1000, 2000, 3000, 1000),  // past end, nothing released
        ];

        for case in &cases {
            let stream = test_stream(case.0, case.1, case.2, case.3);
            let result = withdrawable(&stream, case.4);
            assert_eq!(
                result, Ok(case.5),
                "withdrawable failed: total={}, released={}, start={}, end={}, now={}, expected={}, got={:?}",
                case.0, case.1, case.2, case.3, case.4, case.5, result
            );
        }
    }

    // ── cliff tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_cliff_before_at_and_after() {
        let mut stream = test_stream(1000, 0, 1000, 2000);
        stream.cliff_time = 1400; // 40% cliff

        // Before cliff: vested and withdrawable are 0
        assert_eq!(vested_amount(&stream, 1000), Ok(0));
        assert_eq!(vested_amount(&stream, 1399), Ok(0));
        assert_eq!(withdrawable(&stream, 1399), Ok(0));

        // Exactly at cliff: jumps to linear amount for elapsed time (400 / 1000 * 1000 = 400)
        assert_eq!(vested_amount(&stream, 1400), Ok(400));
        assert_eq!(withdrawable(&stream, 1400), Ok(400));

        // After cliff: continues linearly to total_amount at end_time
        assert_eq!(vested_amount(&stream, 1700), Ok(700));
        assert_eq!(vested_amount(&stream, 2000), Ok(1000));
        assert_eq!(vested_amount(&stream, 2500), Ok(1000));
    }

    #[test]
    fn test_cliff_at_start_time_vests_immediately() {
        let mut stream = test_stream(1000, 0, 1000, 2000);
        stream.cliff_time = 1000;

        assert_eq!(vested_amount(&stream, 1000), Ok(0));
        assert_eq!(vested_amount(&stream, 1250), Ok(250));
        assert_eq!(vested_amount(&stream, 2000), Ok(1000));
    }

    #[test]
    fn test_cliff_at_end_time_withholds_until_end() {
        let mut stream = test_stream(1000, 0, 1000, 2000);
        stream.cliff_time = 2000;

        assert_eq!(vested_amount(&stream, 1500), Ok(0));
        assert_eq!(vested_amount(&stream, 1999), Ok(0));
        assert_eq!(vested_amount(&stream, 2000), Ok(1000));
        assert_eq!(vested_amount(&stream, 2500), Ok(1000));
    }

    #[test]
    fn test_cliff_paused_across_cliff() {
        // Stream [1000, 2000], cliff at 1500 (500s of active time required).
        let mut stream = test_stream(1000, 0, 1000, 2000);
        stream.cliff_time = 1500;

        // Paused at 1200 (200s active elapsed).
        stream.status = StreamStatus::Paused;
        stream.paused_at = 1200;

        // Even when wall clock passes 1500 while paused, active elapsed is still 200 < 500.
        assert_eq!(vested_amount(&stream, 1600), Ok(0));

        // Resumed at 1700 (500s paused): total_paused_duration = 500, end_time = 2500.
        stream.status = StreamStatus::Active;
        stream.paused_at = 0;
        stream.total_paused_duration = 500;
        stream.end_time = 2500;

        // At 1700, active elapsed = 1700 - 1000 - 500 = 200 < 500 -> still 0.
        assert_eq!(vested_amount(&stream, 1700), Ok(0));
        // At 1999, active elapsed = 499 < 500 -> still 0.
        assert_eq!(vested_amount(&stream, 1999), Ok(0));
        // At 2000, active elapsed = 500 >= 500 -> jumps to 500.
        assert_eq!(vested_amount(&stream, 2000), Ok(500));
        // At extended end_time 2500, active elapsed = 1000 -> 1000.
        assert_eq!(vested_amount(&stream, 2500), Ok(1000));
    }

    // ── Milestone release curve tests ────────────────────────────────────────

    fn milestone_stream(
        env: &soroban_sdk::Env,
        total_amount: i128,
        start_time: u64,
        end_time: u64,
        steps: &[(u64, u32)],
    ) -> Stream {
        let mut ms = Vec::new(env);
        for &(time, cumulative_bps) in steps {
            ms.push_back(Milestone {
                time,
                cumulative_bps,
            });
        }
        Stream {
            id: 1,
            sender: Address::generate(env),
            recipient: Address::generate(env),
            token: Address::generate(env),
            total_amount,
            released_amount: 0,
            start_time,
            end_time,
            duration: end_time - start_time,
            last_update: start_time,
            status: StreamStatus::Active,
            paused_at: 0,
            total_paused_duration: 0,
            fee_bps: 0,
            curve: ReleaseCurve::Milestones(ms),
        }
    }

    fn test_milestone_before_between_on_and_after() {
        let env = soroban_sdk::Env::default();
        let stream = milestone_stream(
            &env,
            10_000,
            1000,
            2000,
            &[(1250, 2_500), (1500, 6_000), (2000, 10_000)],
        );

        // Before start and before first milestone
        assert_eq!(vested_amount(&stream, 500), Ok(0));
        assert_eq!(vested_amount(&stream, 1249), Ok(0));

        // Exactly on first milestone and between 1st and 2nd
        assert_eq!(vested_amount(&stream, 1250), Ok(2_500));
        assert_eq!(vested_amount(&stream, 1499), Ok(2_500));

        // Exactly on second milestone and between 2nd and 3rd
        assert_eq!(vested_amount(&stream, 1500), Ok(6_000));
        assert_eq!(vested_amount(&stream, 1999), Ok(6_000));

        // At and after last milestone / end_time
        assert_eq!(vested_amount(&stream, 2000), Ok(10_000));
        assert_eq!(vested_amount(&stream, 5000), Ok(10_000));
    }

    fn test_milestone_single_100_percent() {
        let env = soroban_sdk::Env::default();
        let stream = milestone_stream(&env, 5_000, 1000, 2000, &[(1800, 10_000)]);

        assert_eq!(vested_amount(&stream, 1799), Ok(0));
        assert_eq!(vested_amount(&stream, 1800), Ok(5_000));
        assert_eq!(vested_amount(&stream, 2000), Ok(5_000));
    }

    fn test_milestone_at_start_time() {
        let env = soroban_sdk::Env::default();
        let stream = milestone_stream(
            &env,
            10_000,
            1000,
            2000,
            &[(1000, 2_000), (2000, 10_000)],
        );

        // Before start_time nothing vests even with a milestone at start_time
        assert_eq!(vested_amount(&stream, 999), Ok(0));
        // At start_time the initial milestone unlocks immediately
        assert_eq!(vested_amount(&stream, 1000), Ok(2_000));
        assert_eq!(vested_amount(&stream, 1999), Ok(2_000));
        assert_eq!(vested_amount(&stream, 2000), Ok(10_000));
    }

    fn test_milestone_paused_mid_schedule_never_vests_extra() {
        let env = soroban_sdk::Env::default();
        let mut stream = milestone_stream(
            &env,
            10_000,
            1000,
            2000,
            &[(1250, 2_500), (1500, 6_000), (2000, 10_000)],
        );

        // Pause at 1400 (after 1st milestone, before 2nd)
        stream.paused_at = 1400;

        // Even well past 1500 and 2000, vested stays frozen at 2_500
        assert_eq!(vested_amount(&stream, 1400), Ok(2_500));
        assert_eq!(vested_amount(&stream, 1500), Ok(2_500));
        assert_eq!(vested_amount(&stream, 3000), Ok(2_500));

        // Resume after 300s pause: end_time extended by 300, total_paused_duration = 300
        stream.total_paused_duration = 300;
        stream.end_time = 2300;

        // Effective time at now=1700 is 1400 -> still 2_500
        assert_eq!(vested_amount(&stream, 1700), Ok(2_500));
        // Effective time at now=1800 is 1500 -> 2nd milestone unlocks
        assert_eq!(vested_amount(&stream, 1800), Ok(6_000));
        // Effective time at now=2300 is 2000 -> fully vested
        assert_eq!(vested_amount(&stream, 2300), Ok(10_000));
    }

    fn test_milestone_small_amount_rounding_and_large_amount_overflow() {
        let env = soroban_sdk::Env::default();
        // 1 stroop: 50% floors to 0, 100% vests 1
        let tiny = milestone_stream(&env, 1, 1000, 2000, &[(1500, 5_000), (2000, 10_000)]);
        assert_eq!(vested_amount(&tiny, 1500), Ok(0));
        assert_eq!(vested_amount(&tiny, 2000), Ok(1));

        // i128::MAX at intermediate milestone overflows cleanly; at 10_000 bps returns total_amount
        let huge = milestone_stream(
            &env,
            i128::MAX,
            1000,
            2000,
            &[(1500, 5_000), (2000, 10_000)],
        );
        assert_eq!(vested_amount(&huge, 1500), Err(Error::Overflow));
        assert_eq!(vested_amount(&huge, 2000), Ok(i128::MAX));
    }

    fn test_validate_milestones_accepts_and_rejects() {
        let env = soroban_sdk::Env::default();

        // Empty -> InvalidSchedule
        let empty: Vec<Milestone> = Vec::new(&env);
        assert_eq!(
            validate_milestones(&empty, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Too many (> MAX_MILESTONES) -> InvalidSchedule
        let mut too_many = Vec::new(&env);
        for i in 0..=MAX_MILESTONES {
            let bps = if i == MAX_MILESTONES { 10_000 } else { i * 100 };
            too_many.push_back(Milestone {
                time: 1000 + u64::from(i),
                cumulative_bps: bps,
            });
        }
        assert_eq!(
            validate_milestones(&too_many, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Duplicate timestamps -> InvalidSchedule
        let mut dup = Vec::new(&env);
        dup.push_back(Milestone {
            time: 1500,
            cumulative_bps: 5_000,
        });
        dup.push_back(Milestone {
            time: 1500,
            cumulative_bps: 10_000,
        });
        assert_eq!(
            validate_milestones(&dup, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Unsorted timestamps -> InvalidSchedule
        let mut unsorted = Vec::new(&env);
        unsorted.push_back(Milestone {
            time: 1600,
            cumulative_bps: 5_000,
        });
        unsorted.push_back(Milestone {
            time: 1400,
            cumulative_bps: 10_000,
        });
        assert_eq!(
            validate_milestones(&unsorted, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Outside [start_time, end_time] -> InvalidSchedule
        let mut before_start = Vec::new(&env);
        before_start.push_back(Milestone {
            time: 999,
            cumulative_bps: 10_000,
        });
        assert_eq!(
            validate_milestones(&before_start, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        let mut after_end = Vec::new(&env);
        after_end.push_back(Milestone {
            time: 2001,
            cumulative_bps: 10_000,
        });
        assert_eq!(
            validate_milestones(&after_end, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Over 10_000 bps -> InvalidSchedule
        let mut over_bps = Vec::new(&env);
        over_bps.push_back(Milestone {
            time: 2000,
            cumulative_bps: 10_001,
        });
        assert_eq!(
            validate_milestones(&over_bps, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Decreasing bps -> InvalidSchedule
        let mut dec_bps = Vec::new(&env);
        dec_bps.push_back(Milestone {
            time: 1500,
            cumulative_bps: 6_000,
        });
        dec_bps.push_back(Milestone {
            time: 1800,
            cumulative_bps: 4_000,
        });
        dec_bps.push_back(Milestone {
            time: 2000,
            cumulative_bps: 10_000,
        });
        assert_eq!(
            validate_milestones(&dec_bps, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Does not end at 10_000 -> InvalidSchedule
        let mut short_bps = Vec::new(&env);
        short_bps.push_back(Milestone {
            time: 2000,
            cumulative_bps: 9_999,
        });
        assert_eq!(
            validate_milestones(&short_bps, 1000, 2000),
            Err(Error::InvalidSchedule)
        );

        // Valid schedule
        let mut valid = Vec::new(&env);
        valid.push_back(Milestone {
            time: 1000,
            cumulative_bps: 2_500,
        });
        valid.push_back(Milestone {
            time: 1500,
            cumulative_bps: 2_500,
        }); // non-decreasing allowed
        valid.push_back(Milestone {
            time: 2000,
            cumulative_bps: 10_000,
        });
        assert_eq!(validate_milestones(&valid, 1000, 2000), Ok(()));
    }
}
