//! Time helpers for stream lifecycle calculations.
//!
//! Contract entrypoints work with ledger timestamps, while stream schedules
//! also need checked duration and carry-forward arithmetic. Keeping those
//! conversions here makes overflow and invalid-range handling consistent
//! across create, start, pause, resume, settle, and balance queries.

use soroban_sdk::Env;

use crate::Error;

/// Returns the current ledger timestamp.
pub fn ledger_timestamp(env: &Env) -> u64 {
    env.ledger().timestamp()
}

/// Returns `end - start` when the range is strictly increasing.
pub fn checked_duration(start: u64, end: u64) -> Result<u64, Error> {
    if end <= start {
        return Err(Error::InvalidTimeRange);
    }

    Ok(end - start)
}

/// Adds a duration to a timestamp, mapping overflow to the contract error.
pub fn checked_add_timestamp(timestamp: u64, duration: u64) -> Result<u64, Error> {
    timestamp
        .checked_add(duration)
        .ok_or(Error::InvalidTimeRange)
}

/// Computes the elapsed pause duration from `pause_time` to `now`.
pub fn checked_pause_duration(now: u64, pause_time: u64) -> Result<u64, Error> {
    now.checked_sub(pause_time).ok_or(Error::InvalidTimeRange)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn checked_duration_rejects_empty_or_reversed_ranges() {
        assert_eq!(checked_duration(10, 10), Err(Error::InvalidTimeRange));
        assert_eq!(checked_duration(11, 10), Err(Error::InvalidTimeRange));
    }

    #[test]
    fn checked_duration_returns_strict_range_width() {
        assert_eq!(checked_duration(10, 15), Ok(5));
    }

    #[test]
    fn checked_add_timestamp_rejects_overflow() {
        assert_eq!(
            checked_add_timestamp(u64::MAX, 1),
            Err(Error::InvalidTimeRange)
        );
    }

    #[test]
    fn checked_add_timestamp_returns_sum() {
        assert_eq!(checked_add_timestamp(100, 25), Ok(125));
    }

    #[test]
    fn checked_pause_duration_rejects_clock_regression() {
        assert_eq!(
            checked_pause_duration(99, 100),
            Err(Error::InvalidTimeRange)
        );
    }

    #[test]
    fn checked_pause_duration_returns_elapsed_time() {
        assert_eq!(checked_pause_duration(125, 100), Ok(25));
    }
}
