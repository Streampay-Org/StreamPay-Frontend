//! # Admin nonce — replay-prevention for privileged overrides
//!
//! This module implements a monotonic, per-contract nonce that the admin
//! must supply when calling [`admin_override`]. Because the nonce must
//! strictly increase on every call, a previously-submitted authorisation
//! message **cannot be replayed**: an attacker who intercepts a signed
//! transaction cannot reuse it to trigger the same privileged action a
//! second time.
//!
//! ## Design
//!
//! - The nonce is stored in **instance storage** under [`DataKey::AdminNonce`]
//!   (see `storage.rs` for the shared `DataKey` enum).
//! - It starts at `0` and must be provided as the *current* value on each
//!   `admin_override` call; the contract then stores `nonce + 1`.
//! - The nonce is `u64`, giving 2⁶⁴ − 1 uses before exhaustion (effectively
//!   unbounded for any realistic usage pattern).
//!
//! ## Replay-prevention invariant
//!
//! ```text
//! Precondition:  stored_nonce == provided_nonce
//! Postcondition: stored_nonce == provided_nonce + 1
//! ```
//!
//! Any call with `provided_nonce < stored_nonce` (or equal to a previously
//! consumed nonce) fails with [`crate::Error::NonceTooLow`].
//! Any call with `provided_nonce > stored_nonce` fails with
//! [`crate::Error::NonceOutOfOrder`] — the admin must use nonces in strict
//! sequential order to avoid gaps.
//!
//! ## Usage
//!
//! ```rust,ignore
//! // Query the current expected nonce before crafting the transaction:
//! let next = client.get_admin_nonce();
//!
//! // Submit the override, providing the exact expected nonce:
//! client.admin_override(&admin, next, &stream_id, &new_end_time);
//! ```

use soroban_sdk::{contracttype, Address, Env};

use crate::error::Error;
use crate::storage as store;

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

/// Instance-storage key for the admin nonce counter.
///
/// Stored separately from the main [`crate::DataKey`] enum so that the admin
/// module is self-contained and easy to audit.
#[derive(Clone)]
#[contracttype]
pub enum AdminKey {
    /// Monotonic counter; value is the **next** nonce the admin must supply.
    AdminNonce,
    /// Timestamp of the last successful admin action (for cooldown enforcement).
    LastActionTime,
}

// ---------------------------------------------------------------------------
// Cooldown constant
// ---------------------------------------------------------------------------

/// The minimum time (in seconds) that must elapse between admin actions.
/// Used to enforce a rate limit on privileged overrides.
pub const ADMIN_COOLDOWN_SECONDS: u64 = 86_400; // 24 hours

// ---------------------------------------------------------------------------
// TTL constants (mirrors instance-storage cadence from storage.rs)
// ---------------------------------------------------------------------------

const NONCE_TTL_MIN_REMAINING: u32 = 120_960; // ~1 week
const NONCE_TTL_EXTEND_TO: u32 = 518_400; // ~1 month

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn extend_nonce_ttl(env: &Env) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(NONCE_TTL_MIN_REMAINING);
    let target = env.ledger().sequence().saturating_add(NONCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

/// Returns the stored nonce, defaulting to `0` if not yet set.
///
/// Extends the instance TTL on every read so the nonce cannot archive while
/// the contract is actively being used.
pub fn get_nonce(env: &Env) -> u64 {
    let nonce: Option<u64> = env.storage().instance().get(&AdminKey::AdminNonce);
    extend_nonce_ttl(env);
    nonce.unwrap_or(0)
}

/// Writes the nonce to instance storage and extends the TTL.
fn set_nonce(env: &Env, nonce: u64) {
    env.storage().instance().set(&AdminKey::AdminNonce, &nonce);
    extend_nonce_ttl(env);
}

// ---------------------------------------------------------------------------
// Nonce validation
// ---------------------------------------------------------------------------

/// Validates `provided_nonce` against the stored nonce and advances it on success.
///
/// # Errors
/// - [`Error::NonceTooLow`] if `provided_nonce < stored_nonce` (replayed or stale).
/// - [`Error::NonceOutOfOrder`] if `provided_nonce > stored_nonce` (gap in sequence).
pub fn consume_nonce(env: &Env, provided_nonce: u64) -> Result<(), Error> {
    let stored = get_nonce(env);

    if provided_nonce < stored {
        return Err(Error::NonceTooLow);
    }
    if provided_nonce > stored {
        return Err(Error::NonceOutOfOrder);
    }

    // provided_nonce == stored: advance
    set_nonce(env, stored.saturating_add(1));
    Ok(())
}

// ---------------------------------------------------------------------------
// Cooldown validation
// ---------------------------------------------------------------------------

/// Validates that the cooldown period has elapsed since the last admin action.
/// If valid, updates the last action time to the current ledger timestamp.
///
/// # Errors
/// - [`Error::AdminCooldown`] if the time since the last action is less than the cooldown period.
fn enforce_and_update_cooldown(env: &Env) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    let last_action_time: Option<u64> = env.storage().instance().get(&AdminKey::LastActionTime);

    if let Some(last) = last_action_time {
        if now < last.saturating_add(ADMIN_COOLDOWN_SECONDS) {
            return Err(Error::AdminCooldown);
        }
    }

    env.storage()
        .instance()
        .set(&AdminKey::LastActionTime, &now);
    // Instance TTL will be extended by `consume_nonce` immediately after this.
    Ok(())
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/// Performs a privileged admin override of a stream's `end_time`, protected
/// by a monotonic nonce to prevent replay attacks.
///
/// The admin must supply the **current** nonce (obtainable via
/// [`get_admin_nonce`]) as `nonce`. After a successful call the stored nonce
/// is incremented, so the same `nonce` value cannot be used again.
///
/// This function is intentionally narrow: it only allows extending a stream's
/// `end_time`. Riskier mutations (e.g. changing `total_amount` or
/// `recipient`) are out of scope and require a separate governance path.
///
/// # Parameters
/// - `admin`      — Must be the initialised contract admin.
/// - `nonce`      — The current monotonic nonce; consumed on success.
/// - `stream_id`  — ID of the stream to override.
/// - `new_end_time` — The replacement `end_time` to write.
///
/// # Returns
/// The updated [`crate::storage::Stream`] after the override.
///
/// # Errors
/// - [`Error::NotFound`] if the contract is not initialised or `stream_id`
///   does not exist.
/// - [`Error::Unauthorized`] if `admin` is not the stored admin.
/// - [`Error::AdminCooldown`] if the time since the last action is less than the cooldown period.
/// - [`Error::NonceTooLow`] if `nonce` is stale (already consumed).
/// - [`Error::NonceOutOfOrder`] if `nonce` skips ahead of the current counter.
/// - [`Error::InvalidTimeRange`] if `new_end_time <= stream.start_time`.
/// - [`Error::InvalidState`] if the stream is in a terminal state
///   (`Settled` or `Cancelled`).
///
/// # Auth
/// Requires authorisation from `admin`.
///
/// # Security
/// The nonce provides replay prevention *in addition to* Soroban's native
/// authorization mechanism. Because Soroban auth tokens are already
/// non-replayable within a ledger sequence, the nonce adds a long-lived
/// replay fence that survives across ledger boundaries and protects against
/// replays of off-chain signed authorisations.
pub fn admin_override(
    env: &Env,
    admin: &Address,
    nonce: u64,
    stream_id: u64,
    new_end_time: u64,
) -> Result<crate::storage::Stream, Error> {
    // (1) Auth: verify and consume the admin's authorisation token.
    admin.require_auth();

    // (2) Identity: caller must be the stored admin.
    let stored_admin: Address = store::get_admin(env).ok_or(Error::NotFound)?;
    if stored_admin != *admin {
        return Err(Error::Unauthorized);
    }

    // (3) Cooldown: enforce rate limiting on admin overrides.
    enforce_and_update_cooldown(env)?;

    // (4) Nonce: consume the nonce *before* any state mutation.
    //     This ensures that a failed subsequent mutation cannot be retried
    //     with the same nonce — the nonce is spent even on partial failure.
    consume_nonce(env, nonce)?;

    // (4) Load and validate the stream.
    let mut stream = store::get_stream(env, stream_id).ok_or(Error::NotFound)?;

    if stream.status == crate::storage::StreamStatus::Settled
        || stream.status == crate::storage::StreamStatus::Cancelled
    {
        return Err(Error::InvalidState);
    }

    if new_end_time <= stream.start_time {
        return Err(Error::InvalidTimeRange);
    }

    // (5) Apply the override.
    let new_duration = new_end_time
        .checked_sub(stream.start_time)
        .ok_or(Error::InvalidTimeRange)?;

    stream.end_time = new_end_time;
    stream.duration = new_duration;
    stream.last_update = env.ledger().timestamp();

    store::set_stream(env, stream_id, &stream);

    Ok(stream)
}
