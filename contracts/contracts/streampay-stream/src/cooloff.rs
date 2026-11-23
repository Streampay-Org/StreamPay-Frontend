//! # Per-user cooloff between stream creations
//!
//! After a sender creates a stream, they must wait for a configurable cooloff
//! period before creating another stream.  This prevents rapid-fire stream
//! creation and provides a safety window between a sender's stream operations.
//!
//! ## Storage layout
//!
//! - `CooloffDuration` — Instance-storage singleton (`u64` seconds; `0` = no cooloff).
//! - `CooloffUntil(sender)` — Persistent per-sender entry (`u64` timestamp).
//!
//! ## Entrypoints
//!
//! - [`set_cooloff_duration`] — Admin-only; sets the global cooloff duration.
//! - [`get_cooloff_duration`] — Read-only; returns the current cooloff duration.
//! - [`get_cooloff_until`] — Read-only; returns when a sender's cooloff expires.
//!
//! ## Internal
//!
//! - [`check_and_update_cooloff`] — Guard called inside `create_stream` /
//!   `create_draft_stream`.  Verifies the sender's cooloff has elapsed and
//!   then advances the expiry window by `CooloffDuration`.

use soroban_sdk::{contracttype, Address, Env};

use crate::Error;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default cooloff duration (seconds).  `0` means no cooloff is enforced
/// until the admin explicitly sets a non-zero duration.
pub const DEFAULT_COOLOFF_DURATION: u64 = 0;

/// TTL constants for per-sender cooloff entries, matching the stream-row
/// cadence so a sender with an active cooloff does not expire mid-window.
const COOLOFF_TTL_MIN_REMAINING: u32 = 241_920; // ~2 weeks at 5-second ledgers
const COOLOFF_TTL_EXTEND_TO: u32 = 1_555_200; // ~3 months at 5-second ledgers

/// Instance-storage TTL for the cooloff-duration singleton, matching
/// `storage::INSTANCE_TTL_*`.
const INSTANCE_TTL_MIN_REMAINING: u32 = 120_960; // ~1 week
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400; // ~1 month

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub(crate) enum CooloffKey {
    /// Global cooloff duration in seconds (instance storage).
    CooloffDuration,
    /// Timestamp until which `sender` is blocked from creating new streams
    /// (persistent storage, keyed by sender address).
    CooloffUntil(Address),
}

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

fn ttl_target(env: &Env, extra: u32) -> u32 {
    env.ledger().sequence().saturating_add(extra)
}

fn extend_instance_ttl(env: &Env) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(INSTANCE_TTL_MIN_REMAINING);
    let target = ttl_target(env, INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

fn extend_sender_cooloff_ttl(env: &Env, sender: &Address) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(COOLOFF_TTL_MIN_REMAINING);
    let target = ttl_target(env, COOLOFF_TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(
        &CooloffKey::CooloffUntil(sender.clone()),
        threshold,
        target,
    );
}

// ---------------------------------------------------------------------------
// Admin-configurable duration
// ---------------------------------------------------------------------------

/// Returns the current global cooloff duration in seconds.
///
/// Defaults to `0` (no cooloff enforced) if never set.
///
/// This is a read-only helper; it does not require auth and never returns an
/// error.
pub fn get_cooloff_duration(env: &Env) -> u64 {
    let stored: Option<u64> = env.storage().instance().get(&CooloffKey::CooloffDuration);
    if stored.is_some() {
        extend_instance_ttl(env);
    }
    stored.unwrap_or(DEFAULT_COOLOFF_DURATION)
}

/// Sets the global cooloff duration (in seconds).
///
/// A duration of `0` disables the cooloff check entirely.
///
/// # Auth
///
/// This function does **not** perform auth — the caller is expected to have
/// verified admin privileges before calling.
pub fn set_cooloff_duration(env: &Env, duration: u64) {
    env.storage()
        .instance()
        .set(&CooloffKey::CooloffDuration, &duration);
    extend_instance_ttl(env);
}

// ---------------------------------------------------------------------------
// Per-sender cooloff state
// ---------------------------------------------------------------------------

/// Returns the timestamp until which `sender` is blocked from creating new
/// streams (a `u64` ledger timestamp).
///
/// Returns `0` if the sender has no recorded cooloff (meaning no cooloff is
/// currently active for them).
pub fn get_cooloff_until(env: &Env, sender: &Address) -> u64 {
    let until: Option<u64> = env
        .storage()
        .persistent()
        .get(&CooloffKey::CooloffUntil(sender.clone()));
    if until.is_some() {
        extend_sender_cooloff_ttl(env, sender);
    }
    until.unwrap_or(0)
}

/// Records the cooloff expiry for `sender` as `now + duration`.
///
/// If `duration == 0` this is a no-op (no cooloff to set).
fn set_cooloff_until(env: &Env, sender: &Address, duration: u64) {
    if duration == 0 {
        return;
    }
    let now = env.ledger().timestamp();
    let until = now.saturating_add(duration);
    env.storage()
        .persistent()
        .set(&CooloffKey::CooloffUntil(sender.clone()), &until);
    extend_sender_cooloff_ttl(env, sender);
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/// Checks whether `sender` is currently in cooloff and, if not, advances the
/// cooloff window forward by the configured duration.
///
/// # Errors
///
/// - [`Error::CooloffActive`] if the current ledger timestamp is strictly
///   before the sender's cooloff expiry.
pub fn check_and_update_cooloff(env: &Env, sender: &Address) -> Result<(), Error> {
    let duration = get_cooloff_duration(env);
    if duration == 0 {
        // Cooloff is disabled globally; nothing to check or update.
        return Ok(());
    }

    let now = env.ledger().timestamp();
    let until = get_cooloff_until(env, sender);

    if now < until {
        return Err(Error::CooloffActive);
    }

    // Cooloff has elapsed (or never set).  Start a new cooloff window.
    set_cooloff_until(env, sender, duration);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Contract;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    struct TestData {
        env: Env,
        sender: Address,
        contract_id: soroban_sdk::Address,
    }

    fn setup() -> TestData {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        let contract_id = env.register(Contract, ());
        let sender = Address::generate(&env);
        TestData {
            env,
            sender,
            contract_id,
        }
    }

    // ── get_cooloff_duration ─────────────────────────────────────────────

    #[test]
    fn default_cooloff_duration_is_zero() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            assert_eq!(get_cooloff_duration(&t.env), 0);
        });
    }

    #[test]
    fn set_and_get_cooloff_duration() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 3600);
            assert_eq!(get_cooloff_duration(&t.env), 3600);
        });
    }

    #[test]
    fn set_cooloff_duration_to_zero_disables_cooloff() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 3600);
            assert_eq!(get_cooloff_duration(&t.env), 3600);
            set_cooloff_duration(&t.env, 0);
            assert_eq!(get_cooloff_duration(&t.env), 0);
        });
    }

    // ── get_cooloff_until ────────────────────────────────────────────────

    #[test]
    fn default_cooloff_until_is_zero() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            assert_eq!(get_cooloff_until(&t.env, &t.sender), 0);
        });
    }

    // ── check_and_update_cooloff ─────────────────────────────────────────

    #[test]
    fn check_and_update_with_zero_duration_is_noop() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            // Duration is 0 (default) — should always pass.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
            // Second call immediately after should also pass.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
        });
    }

    #[test]
    fn check_and_update_blocks_second_call_within_cooloff() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);

            // First call: enters cooloff.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Second call: still within cooloff → error.
            let err = check_and_update_cooloff(&t.env, &t.sender).unwrap_err();
            assert_eq!(err, Error::CooloffActive);
        });
    }

    #[test]
    fn cooloff_expires_after_duration_elapses() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);

            // First call: enters cooloff (now = 1000, cooloff until = 1100).
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Advance time past cooloff expiry.
            t.env.ledger().set_timestamp(1_100);

            // Cooloff should have expired.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
        });
    }

    #[test]
    fn cooloff_extends_on_each_successful_call() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);

            // First stream: cooloff until 1100.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Wait until 1100 — cooloff expired.
            t.env.ledger().set_timestamp(1_100);

            // Second stream: cooloff extends to 1200.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Immediately try again — should be blocked until 1200.
            let err = check_and_update_cooloff(&t.env, &t.sender).unwrap_err();
            assert_eq!(err, Error::CooloffActive);

            // Advance to 1200.
            t.env.ledger().set_timestamp(1_200);

            // Should succeed again.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
        });
    }

    #[test]
    fn cooloff_is_per_sender() {
        let t = setup();
        let other = Address::generate(&t.env);

        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);

            // Sender A enters cooloff.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Sender B is not in cooloff.
            assert!(check_and_update_cooloff(&t.env, &other).is_ok());

            // Sender A is still blocked.
            let err = check_and_update_cooloff(&t.env, &t.sender).unwrap_err();
            assert_eq!(err, Error::CooloffActive);
        });
    }

    #[test]
    fn cooloff_disabled_when_duration_is_zero() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            // Duration starts at 0 — no cooloff.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            // Enable cooloff.
            set_cooloff_duration(&t.env, 100);
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
            let err = check_and_update_cooloff(&t.env, &t.sender).unwrap_err();
            assert_eq!(err, Error::CooloffActive);

            // Disable cooloff again.
            set_cooloff_duration(&t.env, 0);
            // Even though the stored cooloff_until is still in the future,
            // duration=0 means the guard in check_and_update_cooloff skips.
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
        });
    }

    // ── TTL extension ────────────────────────────────────────────────────

    #[test]
    fn set_cooloff_duration_extends_instance_ttl() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 3600);
            let ttl = t.env.storage().instance().get_ttl();
            assert_eq!(ttl, INSTANCE_TTL_EXTEND_TO);
        });
    }

    #[test]
    fn check_and_update_sets_and_extends_sender_ttl() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());

            let ttl = t
                .env
                .storage()
                .persistent()
                .get_ttl(&CooloffKey::CooloffUntil(t.sender.clone()));
            assert_eq!(ttl, COOLOFF_TTL_EXTEND_TO);
        });
    }

    #[test]
    fn get_cooloff_until_re_extends_sender_ttl() {
        let t = setup();
        t.env.as_contract(&t.contract_id, || {
            set_cooloff_duration(&t.env, 100);
            assert!(check_and_update_cooloff(&t.env, &t.sender).is_ok());
        });

        // Advance ledgers so TTL would be below threshold.
        let new_seq = COOLOFF_TTL_EXTEND_TO
            .saturating_sub(COOLOFF_TTL_MIN_REMAINING)
            .saturating_add(1);
        t.env.ledger().set_sequence_number(new_seq);

        t.env.as_contract(&t.contract_id, || {
            let ttl_before: u32 = t
                .env
                .storage()
                .persistent()
                .get_ttl(&CooloffKey::CooloffUntil(t.sender.clone()));
            assert_eq!(ttl_before, COOLOFF_TTL_MIN_REMAINING - 1);

            let _ = get_cooloff_until(&t.env, &t.sender);

            let ttl_after = t
                .env
                .storage()
                .persistent()
                .get_ttl(&CooloffKey::CooloffUntil(t.sender.clone()));
            assert_eq!(ttl_after, COOLOFF_TTL_EXTEND_TO);
        });
    }
}
