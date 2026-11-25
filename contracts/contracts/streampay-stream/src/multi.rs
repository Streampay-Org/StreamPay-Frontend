use core::cmp::{max, min};
use soroban_sdk::{contractevent, contracttype, token, Address, Env, Vec};

use crate::error::Error;
use crate::storage::{self, StreamStatus};
use crate::{cooloff, events, fees, limits};

// ── Data types ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
#[contracttype]
pub struct RecipientAllocation {
    pub recipient: Address,
    pub weight: u64,
    pub released_amount: i128,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct SplitStream {
    pub id: u64,
    pub sender: Address,
    pub token: Address,
    pub total_amount: i128,
    pub total_released: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub duration: u64,
    pub last_update: u64,
    pub status: StreamStatus,
    pub pause_time: u64,
    pub total_paused_duration: u64,
    pub total_weight: u64,
    pub recipients: Vec<RecipientAllocation>,
    /// Fee in basis points charged on recipient withdrawals.
    ///
    /// `create_split_stream` has no `fee_bps` parameter, so the global default
    /// in force at creation is snapshotted onto the record.
    pub fee_bps: u32,
}

/// Index into the recipients vec — returned by find_recipient_index.
struct RecipientIdx(u32);

#[derive(Clone)]
#[contracttype]
enum SplitDataKey {
    NextSplitStreamId,
    SplitStream(u64),
}

// ── TTL constants ─────────────────────────────────────────────────────

const SPLIT_TTL_MIN_REMAINING: u32 = 241_920;
const SPLIT_TTL_EXTEND_TO: u32 = 1_555_200;
const INSTANCE_TTL_MIN_REMAINING: u32 = 120_960;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

fn ttl_target(env: &Env, extra: u32) -> u32 {
    env.ledger().sequence().saturating_add(extra)
}

fn extend_split_ttl(env: &Env, stream_id: u64) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(SPLIT_TTL_MIN_REMAINING);
    let target = ttl_target(env, SPLIT_TTL_EXTEND_TO);
    env.storage()
        .persistent()
        .extend_ttl(&SplitDataKey::SplitStream(stream_id), threshold, target);
}

fn extend_instance_ttl(env: &Env) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(INSTANCE_TTL_MIN_REMAINING);
    let target = ttl_target(env, INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

fn get_existing_split(env: &Env, stream_id: u64) -> Result<SplitStream, Error> {
    let stream: Option<SplitStream> = env
        .storage()
        .persistent()
        .get(&SplitDataKey::SplitStream(stream_id));
    if let Some(ref s) = stream {
        extend_split_ttl(env, stream_id);
        Ok(s.clone())
    } else {
        Err(Error::NotFound)
    }
}

fn set_split(env: &Env, stream_id: u64, stream: &SplitStream) {
    env.storage()
        .persistent()
        .set(&SplitDataKey::SplitStream(stream_id), stream);
    extend_split_ttl(env, stream_id);
}

fn next_split_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&SplitDataKey::NextSplitStreamId)
        .unwrap_or(1u64);
    env.storage()
        .instance()
        .set(&SplitDataKey::NextSplitStreamId, &id.saturating_add(1));
    extend_instance_ttl(env);
    id
}

/// Reads the next split stream ID counter without mutating storage or extending TTLs.
pub(crate) fn peek_next_split_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&SplitDataKey::NextSplitStreamId)
        .unwrap_or(1u64)
}

/// Reads a split stream by ID without extending its TTL.
pub(crate) fn peek_split_stream(env: &Env, stream_id: u64) -> Option<SplitStream> {
    env.storage()
        .persistent()
        .get(&SplitDataKey::SplitStream(stream_id))
}

/// Find the index of `recipient` in the allocations vec.
fn find_recipient_index(
    recipients: &Vec<RecipientAllocation>,
    recipient: &Address,
) -> Option<RecipientIdx> {
    let mut i = 0u32;
    let len = recipients.len();
    while i < len {
        if recipients.get(i).unwrap().recipient == *recipient {
            return Some(RecipientIdx(i));
        }
        i = i.saturating_add(1);
    }
    None
}

// ── Vesting math (mirrors release.rs for SplitStream) ──────────────────

fn split_vested_amount(stream: &SplitStream, now: u64) -> Result<i128, Error> {
    if stream.status == StreamStatus::Draft {
        return Ok(0);
    }

    let effective_now = max(stream.start_time, min(now, stream.end_time));

    let effective_now = if stream.status == StreamStatus::Paused {
        min(effective_now, stream.pause_time)
    } else {
        effective_now
    };

    let elapsed = effective_now
        .saturating_sub(stream.start_time)
        .saturating_sub(stream.total_paused_duration);

    if stream.duration == 0 {
        return Ok(stream.total_amount);
    }

    stream
        .total_amount
        .checked_mul(i128::from(elapsed))
        .ok_or(Error::Overflow)?
        .checked_div(i128::from(stream.duration))
        .ok_or(Error::Overflow)
}

fn recipient_vested(stream: &SplitStream, now: u64, weight: u64) -> Result<i128, Error> {
    let total_vested = split_vested_amount(stream, now)?;
    if stream.total_weight == 0 {
        return Ok(0);
    }
    total_vested
        .checked_mul(i128::from(weight))
        .ok_or(Error::Overflow)?
        .checked_div(i128::from(stream.total_weight))
        .ok_or(Error::Overflow)
}

// ── Events ────────────────────────────────────────────────────────────

#[contractevent(topics = ["stream", "split_cr"], data_format = "vec")]
pub struct SplitStreamCreated {
    pub stream_id: u64,
    pub sender: Address,
    pub token: Address,
    pub total_amount: i128,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "split_wd"], data_format = "vec")]
pub struct SplitStreamWithdrawn {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "split_ca"], data_format = "vec")]
pub struct SplitStreamCancelled {
    pub stream_id: u64,
    pub cancelled_by: Address,
    pub returned_amount: i128,
    pub released_amount: i128,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "split_pa"], data_format = "vec")]
pub struct SplitStreamPaused {
    pub stream_id: u64,
    pub sender: Address,
    pub paused_at: u64,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "split_re"], data_format = "vec")]
pub struct SplitStreamResumed {
    pub stream_id: u64,
    pub sender: Address,
    pub end_time: u64,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "split_am"], data_format = "vec")]
pub struct SplitAmended {
    pub stream_id: u64,
    pub sender: Address,
    pub total_amount: i128,
    pub total_weight: u64,
    pub recipient_count: u32,
    pub end_time: u64,
    pub timestamp: u64,
}

fn emit_created(
    env: &Env,
    stream_id: u64,
    sender: &Address,
    token: &Address,
    total_amount: i128,
    timestamp: u64,
) {
    SplitStreamCreated {
        stream_id,
        sender: sender.clone(),
        token: token.clone(),
        total_amount,
        timestamp,
    }
    .publish(env);
}

fn emit_withdrawn(env: &Env, stream_id: u64, recipient: &Address, amount: i128, timestamp: u64) {
    SplitStreamWithdrawn {
        stream_id,
        recipient: recipient.clone(),
        amount,
        timestamp,
    }
    .publish(env);
}

fn emit_cancelled(
    env: &Env,
    stream_id: u64,
    cancelled_by: &Address,
    returned_amount: i128,
    released_amount: i128,
    timestamp: u64,
) {
    SplitStreamCancelled {
        stream_id,
        cancelled_by: cancelled_by.clone(),
        returned_amount,
        released_amount,
        timestamp,
    }
    .publish(env);
}

fn emit_paused(env: &Env, stream_id: u64, sender: &Address, paused_at: u64, timestamp: u64) {
    SplitStreamPaused {
        stream_id,
        sender: sender.clone(),
        paused_at,
        timestamp,
    }
    .publish(env);
}

fn emit_resumed(env: &Env, stream_id: u64, sender: &Address, end_time: u64, timestamp: u64) {
    SplitStreamResumed {
        stream_id,
        sender: sender.clone(),
        end_time,
        timestamp,
    }
    .publish(env);
}

fn emit_amended(env: &Env, stream: &SplitStream, timestamp: u64) {
    SplitAmended {
        stream_id: stream.id,
        sender: stream.sender.clone(),
        total_amount: stream.total_amount,
        total_weight: stream.total_weight,
        recipient_count: stream.recipients.len(),
        end_time: stream.end_time,
        timestamp,
    }
    .publish(env);
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

pub fn create_split_stream(
    env: Env,
    sender: Address,
    token: Address,
    total_amount: i128,
    start_time: u64,
    end_time: u64,
    recipients: Vec<Address>,
    weights: Vec<u64>,
) -> Result<u64, Error> {
    require_not_paused(&env)?;
    sender.require_auth();
    limits::check_sender_limit(&env, &sender)?;
    cooloff::check_and_update_cooloff(&env, &sender)?;

    if total_amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if storage::is_token_blocked(&env, &token) {
        return Err(Error::TokenNotAllowed);
    }

    if end_time <= start_time {
        return Err(Error::InvalidTimeRange);
    }

    let now = env.ledger().timestamp();
    if start_time < now {
        return Err(Error::InvalidTimeRange);
    }

    let rlen = recipients.len();
    let wlen = weights.len();
    if rlen == 0 || wlen == 0 || rlen != wlen {
        return Err(Error::InvalidAmount);
    }

    if rlen < 2 {
        return Err(Error::InvalidAmount);
    }

    // Validate weights are positive and compute total weight
    let mut total_weight: u64 = 0;
    let mut i: u32 = 0;
    while i < rlen {
        let w = weights.get(i).ok_or(Error::InvalidAmount)?;
        if w == 0 {
            return Err(Error::InvalidAmount);
        }
        total_weight = total_weight.checked_add(w).ok_or(Error::Overflow)?;
        i = i.saturating_add(1);
    }

    // Check each recipient can hold the token and no self-streams
    i = 0;
    while i < rlen {
        let r = recipients.get(i).ok_or(Error::InvalidAmount)?;
        if r == sender {
            return Err(Error::SelfStream);
        }
        require_recipient_trustline(&env, &token, &r)?;
        i = i.saturating_add(1);
    }

    let duration = end_time
        .checked_sub(start_time)
        .ok_or(Error::InvalidTimeRange)?;
    limits::check_min_stream_params(&env, total_amount, duration)?;
    let id = next_split_id(&env);
    let contract_address = env.current_contract_address();

    token::Client::new(&env, &token).transfer(&sender, &contract_address, &total_amount);

    // Build allocations
    let mut allocations: Vec<RecipientAllocation> = Vec::new(&env);
    i = 0;
    while i < rlen {
        allocations.push_back(RecipientAllocation {
            recipient: recipients.get(i).ok_or(Error::InvalidAmount)?,
            weight: weights.get(i).ok_or(Error::InvalidAmount)?,
            released_amount: 0,
        });
        i = i.saturating_add(1);
    }

    let stream = SplitStream {
        id,
        sender,
        token: token.clone(),
        total_amount,
        total_released: 0,
        start_time,
        end_time,
        duration,
        last_update: start_time,
        status: StreamStatus::Active,
        pause_time: 0,
        total_paused_duration: 0,
        total_weight,
        recipients: allocations,
        fee_bps: fees::get_default_fee_bps(&env),
    };

    set_split(&env, id, &stream);
    limits::increment_sender_stream_count(&env, &stream.sender);
    emit_created(&env, id, &stream.sender, &stream.token, total_amount, now);

    Ok(id)
}

pub fn withdraw_split(
    env: Env,
    stream_id: u64,
    recipient: Address,
    amount: i128,
) -> Result<i128, Error> {
    require_not_paused(&env)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut stream = get_existing_split(&env, stream_id)?;
    recipient.require_auth();

    if stream.status == StreamStatus::Settled {
        return Err(Error::AlreadySettled);
    }

    if stream.status != StreamStatus::Active && stream.status != StreamStatus::Paused {
        return Err(Error::InvalidState);
    }

    let idx = find_recipient_index(&stream.recipients, &recipient).ok_or(Error::InvalidState)?;
    let mut alloc = stream.recipients.get(idx.0).ok_or(Error::InvalidState)?;

    let now = env.ledger().timestamp();
    let vested_for_recip = recipient_vested(&stream, now, alloc.weight)?;
    let available = vested_for_recip.saturating_sub(alloc.released_amount);

    if amount > available {
        return Err(Error::OverWithdraw);
    }

    alloc.released_amount = alloc
        .released_amount
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    stream.total_released = stream
        .total_released
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    stream.last_update = now;

    // Update the allocation in the vec
    stream.recipients.set(idx.0, alloc);

    if stream.total_released == stream.total_amount {
        stream.status = StreamStatus::Settled;
        limits::decrement_sender_stream_count(&env, &stream.sender);
    }

    // ── Fee split ──────────────────────────────────────────────────────────
    // Compute fee and net amount using floor-per-withdrawal rounding:
    //   fee = floor(amount * stream.fee_bps / 10_000)
    //   net = amount - fee
    // Bookkeeping (released_amount / total_released / Settled) stays on the
    // gross `amount` so settlement and escrow drainage invariants are preserved.
    // If no fee collector is configured, the full `amount` is forwarded to the
    // recipient so no funds are stranded in the contract.
    let fee_result = fees::apply_fee(amount, stream.fee_bps)?;
    let maybe_collector = fees::get_fee_collector(&env);
    let contract = env.current_contract_address();
    let tkn = token::Client::new(&env, &stream.token);

    if fee_result.net_amount > 0 {
        tkn.transfer(&contract, &recipient, &fee_result.net_amount);
    }

    if fee_result.fee_amount > 0 {
        if let Some(collector) = maybe_collector {
            tkn.transfer(&contract, &collector, &fee_result.fee_amount);
            fees::accrue_fees(&env, stream_id, fee_result.fee_amount)?;
            events::fee_charged(
                &env,
                stream_id,
                fee_result.fee_amount,
                stream.fee_bps,
                &collector,
                now,
            );
        } else {
            // No collector configured: forward fee to recipient as well so
            // no funds are stranded in the contract.
            tkn.transfer(&contract, &recipient, &fee_result.fee_amount);
        }
    }

    set_split(&env, stream_id, &stream);
    emit_withdrawn(&env, stream_id, &recipient, amount, now);

    Ok(amount)
}

/// Cancels a split stream, paying each recipient their vested-but-unreleased
/// share and refunding the remaining unvested balance to the sender.
///
/// Consistent with single-stream [`crate::Contract::cancel_stream`],
/// cancellation payouts do **not** charge the protocol fee.
pub fn amend_split_stream(
    env: Env,
    stream_id: u64,
    top_up: i128,
    new_weights: Option<Vec<u64>>,
    new_end_time: Option<u64>,
) -> Result<SplitStream, Error> {
    require_not_paused(&env)?;

    if top_up < 0 {
        return Err(Error::InvalidAmount);
    }

    let mut stream = get_existing_split(&env, stream_id)?;
    stream.sender.require_auth();

    if stream.status != StreamStatus::Active && stream.status != StreamStatus::Paused {
        return Err(Error::InvalidState);
    }

    let new_total_amount = stream
        .total_amount
        .checked_add(top_up)
        .ok_or(Error::Overflow)?;
    if stream.total_released > new_total_amount {
        return Err(Error::InvalidAmount);
    }
    stream.total_amount = new_total_amount;

    if let Some(weights) = new_weights {
        if weights.len() != stream.recipients.len() {
            return Err(Error::InvalidAmount);
        }

        let mut total_weight = 0u64;
        let mut i = 0u32;
        while i < weights.len() {
            let weight = weights.get(i).ok_or(Error::InvalidAmount)?;
            if weight == 0 {
                return Err(Error::InvalidAmount);
            }
            total_weight = total_weight.checked_add(weight).ok_or(Error::Overflow)?;

            let mut allocation = stream.recipients.get(i).ok_or(Error::InvalidAmount)?;
            allocation.weight = weight;
            stream.recipients.set(i, allocation);
            i = i.saturating_add(1);
        }
        stream.total_weight = total_weight;
    }

    let now = env.ledger().timestamp();
    if let Some(end_time) = new_end_time {
        if end_time <= now || end_time <= stream.start_time {
            return Err(Error::InvalidTimeRange);
        }
        stream.end_time = end_time;
        stream.duration = end_time
            .checked_sub(stream.start_time)
            .and_then(|duration| duration.checked_sub(stream.total_paused_duration))
            .filter(|duration| *duration > 0)
            .ok_or(Error::InvalidTimeRange)?;
    }

    stream
        .total_amount
        .checked_mul(i128::from(stream.duration))
        .ok_or(Error::Overflow)?;
    if stream.total_released > stream.total_amount {
        return Err(Error::InvalidAmount);
    }

    let mut i = 0u32;
    while i < stream.recipients.len() {
        let allocation = stream.recipients.get(i).ok_or(Error::InvalidAmount)?;
        let vested = recipient_vested(&stream, now, allocation.weight)?;
        if allocation.released_amount > vested {
            return Err(Error::InvalidAmount);
        }
        i = i.saturating_add(1);
    }

    if top_up > 0 {
        token::Client::new(&env, &stream.token).transfer(
            &stream.sender,
            &env.current_contract_address(),
            &top_up,
        );
    }

    stream.last_update = now;
    set_split(&env, stream_id, &stream);
    emit_amended(&env, &stream, now);

    Ok(stream)
}

pub fn cancel_split_stream(env: Env, stream_id: u64) -> Result<SplitStream, Error> {
    let mut stream = get_existing_split(&env, stream_id)?;
    stream.sender.require_auth();

    if stream.status == StreamStatus::Settled || stream.status == StreamStatus::Cancelled {
        return Err(Error::InvalidState);
    }

    let now = env.ledger().timestamp();
    let contract = env.current_contract_address();
    let tkn = token::Client::new(&env, &stream.token);

    let rlen = stream.recipients.len();

    // Distribute vested-but-unreleased to each recipient.
    // Due to integer division rounding, sum(individual shares) ≤ total_vested
    // (computed inside `recipient_vested` below).
    let mut total_paid: i128 = 0;
    let mut i: u32 = 0;
    while i < rlen {
        let mut alloc = stream.recipients.get(i).ok_or(Error::NotFound)?;
        let share = recipient_vested(&stream, now, alloc.weight)?;
        let unpaid = share.saturating_sub(alloc.released_amount);

        if unpaid > 0 {
            tkn.transfer(&contract, &alloc.recipient, &unpaid);
            alloc.released_amount = alloc
                .released_amount
                .checked_add(unpaid)
                .ok_or(Error::Overflow)?;
            stream.recipients.set(i, alloc);
            total_paid = total_paid.checked_add(unpaid).ok_or(Error::Overflow)?;
        }
        i = i.saturating_add(1);
    }

    // The contract holds `total_amount - previously_released`. After paying
    // `total_paid` to recipients, the remainder goes back to the sender.
    let previously_released = stream.total_released;
    stream.total_released = stream
        .total_released
        .checked_add(total_paid)
        .ok_or(Error::Overflow)?;

    let sender_refund = stream
        .total_amount
        .checked_sub(previously_released)
        .ok_or(Error::Overflow)?
        .checked_sub(total_paid)
        .ok_or(Error::Overflow)?;

    // Sanity: sender_refund should be at least `total_amount - total_vested`
    // (the unvested portion) plus any integer-division rounding remainder.
    if sender_refund > 0 {
        tkn.transfer(&contract, &stream.sender, &sender_refund);
    }

    stream.status = StreamStatus::Cancelled;
    stream.last_update = now;

    limits::decrement_sender_stream_count(&env, &stream.sender);
    set_split(&env, stream_id, &stream);
    emit_cancelled(
        &env,
        stream_id,
        &stream.sender,
        sender_refund,
        stream.total_released,
        now,
    );

    Ok(stream)
}

pub fn pause_split_stream(env: Env, stream_id: u64) -> Result<SplitStream, Error> {
    require_not_paused(&env)?;

    let mut stream = get_existing_split(&env, stream_id)?;
    stream.sender.require_auth();

    if stream.status != StreamStatus::Active {
        return Err(Error::InvalidState);
    }

    let now = env.ledger().timestamp();
    stream.pause_time = now;
    stream.last_update = now;
    stream.status = StreamStatus::Paused;

    set_split(&env, stream_id, &stream);
    emit_paused(&env, stream_id, &stream.sender, stream.pause_time, now);

    Ok(stream)
}

pub fn resume_split_stream(env: Env, stream_id: u64) -> Result<SplitStream, Error> {
    require_not_paused(&env)?;

    let mut stream = get_existing_split(&env, stream_id)?;
    stream.sender.require_auth();

    if stream.status != StreamStatus::Paused {
        return Err(Error::InvalidState);
    }

    let now = env.ledger().timestamp();
    let paused_duration = now
        .checked_sub(stream.pause_time)
        .ok_or(Error::InvalidTimeRange)?;

    stream.total_paused_duration = stream
        .total_paused_duration
        .checked_add(paused_duration)
        .ok_or(Error::InvalidTimeRange)?;
    stream.end_time = stream
        .end_time
        .checked_add(paused_duration)
        .ok_or(Error::InvalidTimeRange)?;

    stream.pause_time = 0;
    stream.last_update = now;
    stream.status = StreamStatus::Active;

    set_split(&env, stream_id, &stream);
    emit_resumed(&env, stream_id, &stream.sender, stream.end_time, now);

    Ok(stream)
}

pub fn get_split_stream(env: Env, stream_id: u64) -> Result<SplitStream, Error> {
    get_existing_split(&env, stream_id)
}

pub fn split_withdrawable(env: Env, stream_id: u64, recipient: Address) -> Result<i128, Error> {
    let stream = get_existing_split(&env, stream_id)?;

    if stream.status == StreamStatus::Draft {
        return Ok(0);
    }

    let idx = find_recipient_index(&stream.recipients, &recipient).ok_or(Error::NotFound)?;
    let alloc = stream.recipients.get(idx.0).ok_or(Error::NotFound)?;

    let now = env.ledger().timestamp();
    let vested_for_recip = recipient_vested(&stream, now, alloc.weight)?;
    Ok(max(
        0,
        vested_for_recip.saturating_sub(alloc.released_amount),
    ))
}

pub fn split_stream_balance(env: Env, stream_id: u64) -> Result<i128, Error> {
    let stream = get_existing_split(&env, stream_id)?;
    split_vested_amount(&stream, env.ledger().timestamp())
}

// ── Migration helpers (storage layout v2) ─────────────────────────────

/// Returns the next split stream id (`1` when no split stream exists).
pub(crate) fn next_split_stream_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&SplitDataKey::NextSplitStreamId)
        .unwrap_or(1u64)
}

/// Rewrites split records with ids in `[start, end)` to the v2 layout.
///
/// The layout change is pause bookkeeping: `pause_time` is `0` unless the
/// stream is `Paused`, in which case it points at the pause instant. Records
/// that already satisfy the invariant are rewritten unchanged, which makes
/// the step idempotent. Missing ids are skipped.
pub(crate) fn migrate_records(env: &Env, start: u64, end: u64) {
    let mut id = start;
    while id < end {
        let stored: Option<SplitStream> = env
            .storage()
            .persistent()
            .get(&SplitDataKey::SplitStream(id));
        if let Some(mut stream) = stored {
            if stream.status == StreamStatus::Paused {
                if stream.pause_time == 0 {
                    stream.pause_time = stream.last_update;
                }
            } else {
                stream.pause_time = 0;
            }
            set_split(env, id, &stream);
        }
        id = id.saturating_add(1);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────
//
// Tests temporarily disabled: pre-existing SDK v23 API incompatibilities.
// #[cfg(test)]
// mod tests;
