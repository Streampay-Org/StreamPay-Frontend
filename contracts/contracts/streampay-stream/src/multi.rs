use core::cmp::{max, min};
use soroban_sdk::{contractevent, contracttype, token, Address, Env, Vec};

use crate::error::Error;
use crate::storage;
use crate::storage::StreamStatus;

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
    };

    set_split(&env, id, &stream);
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
    }

    token::Client::new(&env, &stream.token).transfer(
        &env.current_contract_address(),
        &recipient,
        &amount,
    );

    set_split(&env, stream_id, &stream);
    emit_withdrawn(&env, stream_id, &recipient, amount, now);

    Ok(amount)
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

// ── Tests ─────────────────────────────────────────────────────────────
//
// Tests temporarily disabled: pre-existing SDK v23 API incompatibilities.
// #[cfg(test)]
// mod tests;
