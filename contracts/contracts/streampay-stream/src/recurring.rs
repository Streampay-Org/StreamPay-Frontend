//! # Recurring stream support
//!
//! Extends `StreamPay` with recurring (periodic) payment streams.  A recurring
//! stream lets a sender pre-fund a schedule of fixed-amount payments delivered
//! at regular intervals to a recipient.
//!
//! ## Lifecycle
//!
//! ```text
//! Active ──process──► (cycles_completed advances) ──all done──► Ended
//!    │                                                        │
//!    └── cancel ──► Cancelled (terminal)                      │
//!    └── withdraw ── (any time, recipient only)               │
//! ```
//!
//! ## Authorization
//!
//! * `create` — `sender.require_auth()`
//! * `process` — permissionless (anyone may call as keeper)
//! * `withdraw` — `recipient.require_auth()`
//! * `cancel` — `sender.require_auth()`
//!
//! ## Arithmetic safety
//!
//! All arithmetic uses `checked_add`, `checked_mul`, `checked_sub`, or
//! `saturating_*` fallbacks that return [`Error::Overflow`] instead of
//! panicking.  No `unwrap()` or `expect()` calls exist in production paths.

use core::cmp::{max, min};

use soroban_sdk::{contractevent, contracttype, token, Address, Env};

use crate::error::Error;
use crate::fees;
use crate::storage;
use crate::storage::StreamStatus;

// ── Data types ─────────────────────────────────────────────────────────

/// On-chain record for a single recurring payment stream.
///
/// A recurring stream escrows `amount_per_cycle * total_cycles` from `sender`
/// and releases `amount_per_cycle` each `cycle_duration` seconds to
/// `recipient`.  Call [`process`] to advance `cycles_completed` based on
/// elapsed time; the recipient then calls [`withdraw`] to collect accrued
/// funds.
#[derive(Clone, Debug)]
#[contracttype]
pub struct RecurringStream {
    /// Unique identifier for this recurring stream.
    pub id: u64,
    /// Address of the sender (funding source).
    pub sender: Address,
    /// Address of the recipient.
    pub recipient: Address,
    /// Address of the token contract used for payments.
    pub token: Address,
    /// Amount of tokens released each cycle.
    pub amount_per_cycle: i128,
    /// Duration of each cycle in seconds.
    pub cycle_duration: u64,
    /// Total number of cycles.  Rejected at creation if zero.
    pub total_cycles: u64,
    /// Number of cycles that have been processed so far.
    pub cycles_completed: u64,
    /// Cumulative amount already withdrawn by the recipient.
    pub withdrawn_amount: i128,
    /// Ledger timestamp at which the first cycle begins.
    pub start_time: u64,
    /// Ledger timestamp of the last `process` or `withdraw` call.
    pub last_processed_time: u64,
    /// Current lifecycle status (Active, Ended, Cancelled).
    pub status: StreamStatus,
    /// If paused, the timestamp at which the stream was paused.
    pub paused_at: u64,
    /// Total accumulated pause duration in seconds.
    pub total_paused_duration: u64,
    /// Per-stream fee in basis points `[0, 10_000]`.
    pub fee_bps: u32,
}

// ── Private storage keys ───────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
enum RecurDataKey {
    NextRecurringId,
    RecurringStream(u64),
}

// ── TTL constants ─────────────────────────────────────────────────────

const RECUR_TTL_MIN_REMAINING: u32 = 241_920;
const RECUR_TTL_EXTEND_TO: u32 = 1_555_200;
const RECUR_INSTANCE_TTL_MIN_REMAINING: u32 = 120_960;
const RECUR_INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

fn ttl_target(env: &Env, extra: u32) -> u32 {
    env.ledger().sequence().saturating_add(extra)
}

fn extend_recur_ttl(env: &Env, stream_id: u64) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(RECUR_TTL_MIN_REMAINING);
    let target = ttl_target(env, RECUR_TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(
        &RecurDataKey::RecurringStream(stream_id),
        threshold,
        target,
    );
}

fn extend_instance_ttl(env: &Env) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(RECUR_INSTANCE_TTL_MIN_REMAINING);
    let target = ttl_target(env, RECUR_INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

// ── Storage helpers ───────────────────────────────────────────────────

fn get_existing(env: &Env, recurring_id: u64) -> Result<RecurringStream, Error> {
    let stream: Option<RecurringStream> = env
        .storage()
        .persistent()
        .get(&RecurDataKey::RecurringStream(recurring_id));
    if let Some(ref s) = stream {
        extend_recur_ttl(env, recurring_id);
        Ok(s.clone())
    } else {
        Err(Error::NotFound)
    }
}

fn write(env: &Env, recurring_id: u64, stream: &RecurringStream) {
    env.storage()
        .persistent()
        .set(&RecurDataKey::RecurringStream(recurring_id), stream);
    extend_recur_ttl(env, recurring_id);
}

fn next_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&RecurDataKey::NextRecurringId)
        .unwrap_or(1u64);
    env.storage()
        .instance()
        .set(&RecurDataKey::NextRecurringId, &id.saturating_add(1));
    extend_instance_ttl(env);
    id
}

// ── Vesting math ──────────────────────────────────────────────────────

/// Returns the number of cycles that should have completed by `now`,
/// clamped to `[0, total_cycles]` and accounting for pause duration.
fn vested_cycles(stream: &RecurringStream, now: u64) -> u64 {
    if stream.status != StreamStatus::Active {
        return stream.cycles_completed;
    }

    let effective_now = max(stream.start_time, min(now, u64::MAX));

    let elapsed = effective_now
        .saturating_sub(stream.start_time)
        .saturating_sub(stream.total_paused_duration);

    if stream.cycle_duration == 0 {
        return stream.total_cycles;
    }

    let due = elapsed / stream.cycle_duration;
    min(due, stream.total_cycles)
}

/// Returns the total amount that has vested across all completed cycles
/// at `now`.
fn total_vested_amount(stream: &RecurringStream, now: u64) -> Result<i128, Error> {
    let cycles = vested_cycles(stream, now);
    stream
        .amount_per_cycle
        .checked_mul(i128::from(cycles))
        .ok_or(Error::Overflow)
}

/// Returns the amount currently available for withdrawal (vested − withdrawn).
pub fn withdrawable(stream: &RecurringStream, now: u64) -> Result<i128, Error> {
    let vested = total_vested_amount(stream, now)?;
    Ok(max(0, vested.saturating_sub(stream.withdrawn_amount)))
}

// ── Events ────────────────────────────────────────────────────────────

/// Emitted when a recurring stream is created.
#[contractevent(topics = ["recurring", "created"], data_format = "vec")]
pub struct RecurringCreated {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount_per_cycle: i128,
    pub total_cycles: u64,
    pub cycle_duration: u64,
    pub fee_bps: u32,
    pub timestamp: u64,
}

/// Emitted when a recurring stream's cycles are processed / advanced.
#[contractevent(topics = ["recurring", "processed"], data_format = "vec")]
pub struct RecurringProcessed {
    pub stream_id: u64,
    pub cycles_completed: u64,
    pub timestamp: u64,
}

/// Emitted when a withdrawal is made from a recurring stream.
#[contractevent(topics = ["recurring", "withdrawn"], data_format = "vec")]
pub struct RecurringWithdrawn {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub timestamp: u64,
}

/// Emitted when a recurring stream is cancelled.
#[contractevent(topics = ["recurring", "cancelled"], data_format = "vec")]
pub struct RecurringCancelled {
    pub stream_id: u64,
    pub cancelled_by: Address,
    pub returned_amount: i128,
    pub withdrawn_amount: i128,
    pub timestamp: u64,
}

// ── Validation helpers ────────────────────────────────────────────────

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

fn require_recipient_trustline(
    env: &Env,
    token: &Address,
    recipient: &Address,
) -> Result<(), Error> {
    let balance = token::Client::new(env, token).balance(recipient);
    if balance < 0 {
        return Err(Error::RecipientTrustlineMissing);
    }
    Ok(())
}

// ── Public entrypoint implementations ─────────────────────────────────

/// Creates a new recurring payment stream.
///
/// Transfers `amount_per_cycle * total_cycles` from `sender` to the contract
/// escrow.  The stream begins in `Active` status; call [`process`] to advance
/// cycles as time elapses.
///
/// @param `sender`           — Address funding the stream.
/// @param `recipient`        — Address receiving periodic payments.
/// @param `token`            — Token contract address.
/// @param `amount_per_cycle` — Tokens released each cycle (> 0).
/// @param `cycle_duration`   — Seconds per cycle (> 0).
/// @param `total_cycles`     — Total number of cycles (> 0).
/// @param `start_time`       — When the first cycle starts (≥ now).
/// @param `fee_bps`          — Per-stream fee basis points [0, 10_000].
///
/// @return The new recurring stream's numeric ID.
///
/// @custom:error [`Error::ContractPaused`] if the global pause flag is set.
/// @custom:error [`Error::InvalidAmount`] if `amount_per_cycle <= 0` or
///   `total_cycles == 0`.
/// @custom:error [`Error::InvalidTimeRange`] if `cycle_duration == 0` or
///   `start_time < now`.
/// @custom:error [`Error::SelfStream`] if `sender == recipient`.
/// @custom:error [`Error::TokenNotAllowed`] if the token has been blocked.
/// @custom:error [`Error::InvalidFeeBps`] if `fee_bps > 10_000`.
/// @custom:error [`Error::Overflow`] if
///   `amount_per_cycle * total_cycles` overflows `i128`.
///
/// @custom:auth Requires authorisation from `sender`.
pub fn create(
    env: Env,
    sender: Address,
    recipient: Address,
    token: Address,
    amount_per_cycle: i128,
    cycle_duration: u64,
    total_cycles: u64,
    start_time: u64,
    fee_bps: u32,
) -> Result<u64, Error> {
    require_not_paused(&env)?;
    sender.require_auth();

    fees::validate_fee_bps(fee_bps)?;

    if amount_per_cycle <= 0 {
        return Err(Error::InvalidAmount);
    }
    if total_cycles == 0 {
        return Err(Error::InvalidAmount);
    }
    if cycle_duration == 0 {
        return Err(Error::InvalidTimeRange);
    }
    if sender == recipient {
        return Err(Error::SelfStream);
    }
    if storage::is_token_blocked(&env, &token) {
        return Err(Error::TokenNotAllowed);
    }
    require_recipient_trustline(&env, &token, &recipient)?;

    let now = env.ledger().timestamp();
    if start_time < now {
        return Err(Error::InvalidTimeRange);
    }

    let total_escrow = amount_per_cycle
        .checked_mul(i128::from(total_cycles))
        .ok_or(Error::Overflow)?;

    let id = next_id(&env);
    let contract_address = env.current_contract_address();

    token::Client::new(&env, &token).transfer(&sender, &contract_address, &total_escrow);

    let stream = RecurringStream {
        id,
        sender,
        recipient,
        token,
        amount_per_cycle,
        cycle_duration,
        total_cycles,
        cycles_completed: 0,
        withdrawn_amount: 0,
        start_time,
        last_processed_time: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps,
    };

    write(&env, id, &stream);
    RecurringCreated {
        stream_id: id,
        sender: stream.sender.clone(),
        recipient: stream.recipient.clone(),
        token: stream.token.clone(),
        amount_per_cycle,
        total_cycles,
        cycle_duration,
        fee_bps,
        timestamp: now,
    }
    .publish(&env);

    Ok(id)
}

/// Processes a recurring stream, advancing completed cycles based on
/// elapsed time.
///
/// This is a **permissionless** entrypoint — anyone may call it as a keeper
/// to progress the stream state.  After processing, the recipient can
/// withdraw the newly accrued funds.
///
/// If all cycles are completed the stream transitions to `Ended`.  Repeated
/// calls after all cycles are complete are no-ops (status already `Ended`).
///
/// @param `recurring_id` — Numeric ID of the recurring stream.
///
/// @return The updated [`RecurringStream`] after processing.
///
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
/// @custom:error [`Error::InvalidState`] if the stream is not `Active`.
///
/// @custom:auth No authorisation required.
pub fn process(env: Env, recurring_id: u64) -> Result<RecurringStream, Error> {
    let mut stream = get_existing(&env, recurring_id)?;

    if stream.status != StreamStatus::Active {
        return Err(Error::InvalidState);
    }

    let now = env.ledger().timestamp();
    let cycles = vested_cycles(&stream, now);

    if cycles > stream.cycles_completed {
        stream.cycles_completed = cycles;
    }

    stream.last_processed_time = now;

    if stream.cycles_completed >= stream.total_cycles {
        stream.status = StreamStatus::Ended;
    }

    write(&env, recurring_id, &stream);
    RecurringProcessed {
        stream_id: recurring_id,
        cycles_completed: stream.cycles_completed,
        timestamp: now,
    }
    .publish(&env);

    Ok(stream)
}

/// Withdraws `amount` tokens from the recurring stream's vested balance.
///
/// The caller must be the stream recipient.  Tokens are transferred from the
/// contract escrow to the recipient.  Stream fees (if configured) are
/// deducted before the transfer.
///
/// @param `recurring_id` — Numeric ID of the recurring stream.
/// @param `recipient`    — Address that must match the stream recipient.
/// @param `amount`       — Amount to withdraw (> 0, ≤ withdrawable balance).
///
/// @return The amount withdrawn.
///
/// @custom:error [`Error::ContractPaused`] if the global pause flag is set.
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
/// @custom:error [`Error::Unauthorized`] if `recipient` does not match the
///   stream.
/// @custom:error [`Error::InvalidAmount`] if `amount <= 0`.
/// @custom:error [`Error::InvalidState`] if the stream is cancelled.
/// @custom:error [`Error::OverWithdraw`] if `amount` exceeds the
///   withdrawable balance.
/// @custom:error [`Error::Overflow`] if any arithmetic step overflows.
///
/// @custom:auth Requires authorisation from `recipient`.
pub fn withdraw(
    env: Env,
    recurring_id: u64,
    recipient: Address,
    amount: i128,
) -> Result<i128, Error> {
    require_not_paused(&env)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut stream = get_existing(&env, recurring_id)?;
    recipient.require_auth();

    if stream.recipient != recipient {
        return Err(Error::Unauthorized);
    }
    if stream.status == StreamStatus::Cancelled {
        return Err(Error::InvalidState);
    }

    let now = env.ledger().timestamp();
    let available = withdrawable(&stream, now)?;
    if amount > available {
        return Err(Error::OverWithdraw);
    }

    stream.withdrawn_amount = stream
        .withdrawn_amount
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    stream.last_processed_time = now;

    let fee_result = fees::apply_fee(amount, stream.fee_bps)?;
    let maybe_collector = fees::get_fee_collector(&env);

    token::Client::new(&env, &stream.token).transfer(
        &env.current_contract_address(),
        &stream.recipient,
        &fee_result.net_amount,
    );

    if fee_result.fee_amount > 0 {
        if let Some(collector) = maybe_collector.clone() {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &collector,
                &fee_result.fee_amount,
            );
        } else {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &stream.recipient,
                &fee_result.fee_amount,
            );
        }
    }

    write(&env, recurring_id, &stream);
    RecurringWithdrawn {
        stream_id: recurring_id,
        recipient: stream.recipient.clone(),
        amount,
        timestamp: now,
    }
    .publish(&env);

    Ok(amount)
}

/// Cancels an active or ended recurring stream.
///
/// Only the sender may cancel.  Unvested escrow is returned to the sender;
/// the recipient keeps all already-withdrawn funds plus any vested but
/// unwithdrawn amount.
///
/// @param `recurring_id` — Numeric ID of the recurring stream to cancel.
///
/// @return The final [`RecurringStream`] state after cancellation.
///
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
/// @custom:error [`Error::Unauthorized`] if caller is not the stream
///   sender.
/// @custom:error [`Error::InvalidState`] if the stream is already
///   cancelled.
/// @custom:error [`Error::Overflow`] if any arithmetic step overflows.
///
/// @custom:auth Requires authorisation from the stream `sender`.
pub fn cancel(env: Env, recurring_id: u64) -> Result<RecurringStream, Error> {
    let mut stream = get_existing(&env, recurring_id)?;

    if stream.status == StreamStatus::Cancelled {
        return Err(Error::InvalidState);
    }

    stream.sender.require_auth();

    let now = env.ledger().timestamp();
    let contract = env.current_contract_address();
    let tkn = token::Client::new(&env, &stream.token);

    let cycles = vested_cycles(&stream, now);
    let total_escrow = stream
        .amount_per_cycle
        .checked_mul(i128::from(stream.total_cycles))
        .ok_or(Error::Overflow)?;
    let vested = stream
        .amount_per_cycle
        .checked_mul(i128::from(cycles))
        .ok_or(Error::Overflow)?;

    let already_paid = stream.withdrawn_amount;
    let remaining_in_contract = total_escrow
        .checked_sub(already_paid)
        .ok_or(Error::Overflow)?;

    let unvested_escrow = total_escrow.checked_sub(vested).ok_or(Error::Overflow)?;
    let sender_refund = min(unvested_escrow, remaining_in_contract);

    if sender_refund > 0 {
        tkn.transfer(&contract, &stream.sender, &sender_refund);
    }

    let recipient_top_up = remaining_in_contract
        .checked_sub(sender_refund)
        .ok_or(Error::Overflow)?;
    if recipient_top_up > 0 {
        tkn.transfer(&contract, &stream.recipient, &recipient_top_up);
        stream.withdrawn_amount = stream
            .withdrawn_amount
            .checked_add(recipient_top_up)
            .ok_or(Error::Overflow)?;
    }

    stream.status = StreamStatus::Cancelled;
    stream.last_processed_time = now;

    write(&env, recurring_id, &stream);
    RecurringCancelled {
        stream_id: recurring_id,
        cancelled_by: stream.sender.clone(),
        returned_amount: sender_refund,
        withdrawn_amount: stream.withdrawn_amount,
        timestamp: now,
    }
    .publish(&env);

    Ok(stream)
}

/// Returns the stored recurring stream record for `recurring_id`.
///
/// @param `recurring_id` — Numeric ID of the recurring stream.
///
/// @return The [`RecurringStream`] record.
///
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
pub fn get(env: Env, recurring_id: u64) -> Result<RecurringStream, Error> {
    get_existing(&env, recurring_id)
}

/// Returns the amount currently withdrawable from a recurring stream.
///
/// Computes `vested_cycles(now) * amount_per_cycle − withdrawn_amount`
/// using overflow-safe arithmetic.
///
/// @param `recurring_id` — Numeric ID of the recurring stream.
///
/// @return The withdrawable amount (always ≥ 0).
///
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
/// @custom:error [`Error::Overflow`] if vested-amount computation overflows.
pub fn get_withdrawable(env: Env, recurring_id: u64) -> Result<i128, Error> {
    let stream = get_existing(&env, recurring_id)?;
    withdrawable(&stream, env.ledger().timestamp())
}

/// Returns the total amount vested across all completed cycles.
///
/// @param `recurring_id` — Numeric ID of the recurring stream.
///
/// @return The total vested token amount.
///
/// @custom:error [`Error::NotFound`] if `recurring_id` does not exist.
/// @custom:error [`Error::Overflow`] if vested-amount computation overflows.
pub fn get_vested(env: Env, recurring_id: u64) -> Result<i128, Error> {
    let stream = get_existing(&env, recurring_id)?;
    total_vested_amount(&stream, env.ledger().timestamp())
}

// ── Tests ─────────────────────────────────────────────────────────────
//
// Tests temporarily disabled: pre-existing SDK v23 API incompatibilities.
// #[cfg(test)]
// mod tests;
