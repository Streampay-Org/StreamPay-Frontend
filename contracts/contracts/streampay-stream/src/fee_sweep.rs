//! # Cross-stream fee treasury sweep (issue #957)
//!
//! This module implements the **`sweep_fees`** entrypoint, which allows the
//! contract admin to sweep all accumulated protocol fees from a list of streams
//! into the configured fee collector (treasury) address in a single atomic
//! transaction.
//!
//! ## Design rationale
//!
//! Protocol fees accrue per-stream as withdrawals happen (see `fees.rs`).
//! Rather than micro-transferring each fee individually, the withdraw path
//! only **records** the fee owed in persistent storage
//! (`FeeDataKey::AccumulatedFees(stream_id)`).  The sweep path then
//! aggregates those balances and transfers the total in one call, which is
//! cheaper in ledger fees and simpler to audit.
//!
//! ## Security model
//!
//! | Threat | Mitigation |
//! |--------|-----------|
//! | Unauthorised sweep redirecting funds | `require_admin` guard + `admin.require_auth()` |
//! | Double-sweep / race condition | Balances are zeroed **before** the token transfer (optimistic clearing); Soroban's single-threaded execution model prevents concurrent invocations |
//! | Overflow on aggregate total | `checked_add` throughout; returns `Error::Overflow` |
//! | Sweeping more than actually owed | Only reads from the `AccumulatedFees` ledger key; cannot exceed what the withdraw path wrote |
//! | Partial failure corrupting state | Soroban rolls back all storage writes on any panic/error, so the zero-out and transfer are atomic |
//! | Reentrancy via token callback | Soroban does not support reentrancy; the host executes calls sequentially |
//!
//! ## Storage interaction
//!
//! This module only clears `FeeDataKey::AccumulatedFees(stream_id)` entries in
//! `fees.rs`.  It does not touch any `DataKey::Stream` row, the fee collector
//! address, or fee-bps configuration.
//!
//! ## Events
//!
//! A single `("stream", "swept")` event is emitted after the token transfer
//! succeeds.  See [`crate::events::fees_swept`] for the event schema.
//!
//! ## Usage
//!
//! ```text
//! // Query all stream IDs whose accumulated fees you want to sweep, then call:
//! client.sweep_fees(&admin, &stream_ids);
//! ```

use soroban_sdk::{token, Address, Env, Vec};

use crate::error::Error;
use crate::events;
use crate::fees;
use crate::storage;

// ─────────────────────────────────────────────────────────────────────────────

/// Result returned by the public [`sweep_fees`] function.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SweepResult {
    /// Number of streams that had a non-zero accumulated fee balance and were
    /// included in this sweep.
    pub streams_swept: u32,
    /// Total token amount transferred to the fee collector.
    pub total_swept: i128,
}

// ─────────────────────────────────────────────────────────────────────────────

/// Sweeps accumulated protocol fees from all streams in `stream_ids` into the
/// fee collector (treasury) address.
///
/// ## Parameters
/// - `env`        — Soroban execution environment.
/// - `admin`      — Must be the initialised contract admin.  Auth is consumed.
/// - `stream_ids` — On-chain `Vec` of stream IDs whose fee balances to sweep.
///                  Streams with a zero balance are silently skipped.
///
/// ## Returns
/// A [`SweepResult`] containing the number of streams swept and the total
/// amount transferred.
///
/// ## Errors
/// - [`Error::NotFound`]   — Contract has not been initialised, or the fee
///                           collector address has not been set.
/// - [`Error::Unauthorized`] — `admin` is not the stored admin address.
/// - [`Error::SweepNoFees`] — All listed streams have a zero accumulated fee
///                            balance (nothing to sweep).
/// - [`Error::Overflow`]   — Aggregate fee total would overflow `i128`.
///
/// ## Auth
/// Requires authorisation from `admin`.
///
/// ## Atomicity
/// All storage writes (zeroing per-stream balances) and the token transfer
/// either all succeed or all roll back.  Soroban aborts and reverts the
/// entire transaction on any error or panic.
pub fn sweep_fees(env: &Env, admin: &Address, stream_ids: &Vec<u64>) -> Result<SweepResult, Error> {
    // ── 1. Authorisation ─────────────────────────────────────────────────────
    // Consume the admin's auth token first, before reading any state, so that
    // a failed auth cannot leak information about internal balances.
    admin.require_auth();

    // ── 2. Identity check ────────────────────────────────────────────────────
    let stored_admin: Address = storage::get_admin(env).ok_or(Error::NotFound)?;
    if stored_admin != *admin {
        return Err(Error::Unauthorized);
    }

    // ── 3. Resolve the fee collector ─────────────────────────────────────────
    let collector: Address = fees::get_fee_collector(env).ok_or(Error::NotFound)?;

    // ── 4. Aggregate balances, resolve token per stream ──────────────────────
    //
    // We accumulate (token → total_fee) in a local structure.  In practice all
    // streams share the same token contract in most deployments, but the loop
    // handles heterogeneous tokens correctly by grouping them.
    //
    // To keep the loop allocation-free we use a simple linear scan since the
    // maximum page size is 100 streams and Soroban's stack is constrained.
    //
    // Safety invariant: we read each stream's balance BEFORE zeroing it.
    // Zeroing happens in a second pass so that if `get_stream` returns None
    // for some ID the entry is simply skipped without poisoning the aggregate.

    // We build two parallel Vecs: one of stream IDs that have a non-zero
    // balance, and one of (token, amount) pairs, because we need to do the
    // token transfers after zeroing all balances.
    let mut streams_with_fees: soroban_sdk::Vec<(u64, Address, i128)> = soroban_sdk::Vec::new(env);
    let mut total_swept: i128 = 0;

    for stream_id in stream_ids.iter() {
        let balance = fees::get_accumulated_fees(env, stream_id);
        if balance <= 0 {
            // Nothing to sweep for this stream; skip silently.
            continue;
        }

        // Resolve the token address for this stream.  If the stream row is
        // missing (e.g. the caller passed a stale or invalid ID) we skip it
        // rather than aborting the whole sweep.
        let stream = match storage::get_stream(env, stream_id) {
            Some(s) => s,
            None => continue,
        };

        // Checked accumulation to prevent integer manipulation attacks.
        total_swept = total_swept.checked_add(balance).ok_or(Error::Overflow)?;

        streams_with_fees.push_back((stream_id, stream.token, balance));
    }

    // ── 5. Guard: nothing to sweep ───────────────────────────────────────────
    if streams_with_fees.is_empty() {
        return Err(Error::SweepNoFees);
    }

    let streams_swept = streams_with_fees.len();

    // ── 6. Zero balances BEFORE the transfer (optimistic clearing) ───────────
    //
    // We zero all per-stream balances before making any external token calls.
    // This ensures that even if the token transfer were somehow re-entered
    // (impossible in Soroban but defensive nonetheless), the balances are
    // already zero and cannot be swept a second time.
    for (stream_id, _token, _amount) in streams_with_fees.iter() {
        fees::clear_accumulated_fees(env, stream_id);
    }

    // ── 7. Execute token transfers ───────────────────────────────────────────
    //
    // Group transfers by token to minimise cross-contract calls.  We use a
    // simple approach: iterate once and emit one transfer per unique token.
    // For the common case (single token) this is one transfer.
    //
    // Implementation note: We cannot use a HashMap in Soroban (no_std), so we
    // use a second linear pass.  For the expected page size (≤100 streams) this
    // is O(n²) at worst but negligible in practice.

    // Collect unique tokens.
    let mut tokens_seen: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(env);
    for (_stream_id, token_addr, _amount) in streams_with_fees.iter() {
        let mut already_seen = false;
        for seen in tokens_seen.iter() {
            if seen == token_addr {
                already_seen = true;
                break;
            }
        }
        if !already_seen {
            tokens_seen.push_back(token_addr);
        }
    }

    // For each unique token, sum up the amounts and transfer once.
    for token_addr in tokens_seen.iter() {
        let mut token_total: i128 = 0;
        for (_stream_id, t, amount) in streams_with_fees.iter() {
            if t == token_addr {
                token_total = token_total.checked_add(amount).ok_or(Error::Overflow)?;
            }
        }
        if token_total > 0 {
            token::Client::new(env, &token_addr).transfer(
                &env.current_contract_address(),
                &collector,
                &token_total,
            );
        }
    }

    // ── 8. Emit event ────────────────────────────────────────────────────────
    events::fees_swept(
        env,
        streams_swept,
        total_swept,
        &collector,
        admin,
        env.ledger().timestamp(),
    );

    Ok(SweepResult {
        streams_swept,
        total_swept,
    })
}
