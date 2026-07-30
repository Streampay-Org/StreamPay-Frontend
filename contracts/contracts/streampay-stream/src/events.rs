//! # `StreamPay` contract events
//!
//! All events use a two-topic scheme: `("stream", "<event>")`.
//!
//! All events are emitted AFTER successful state mutation and any token transfer.
//! Failed calls (returning Err) emit no events.
//! `settled` is emitted in addition to `withdrawn` when a withdrawal fully drains the stream.

use soroban_sdk::{contractevent, symbol_short, Address, BytesN, Env, Symbol};

/// Emitted when a new stream is created (topic: `"stream"`, sub-topic: `"created"`).
///
/// Contains the stream's ID, sender, recipient, token address, total amount,
/// per-stream fee (in basis points), stream duration in seconds, and the
/// ledger timestamp at creation.
#[contractevent(topics = ["stream", "created"], data_format = "vec")]
pub struct StreamCreated {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub total_amount: i128,
    pub fee_bps: u32,
    pub duration: u64,
    pub timestamp: u64,
}

/// Emitted when a draft stream is started (topic: `"stream"`, sub-topic: `"started"`).
///
/// Records the stream ID, the computed start and end time, and the ledger
/// timestamp of activation.
#[contractevent(topics = ["stream", "started"], data_format = "vec")]
pub struct StreamStarted {
    pub stream_id: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub timestamp: u64,
}

/// Emitted when tokens are withdrawn from a stream (topic: `"stream"`, sub-topic: `"withdrawn"`).
///
/// Contains the stream ID, recipient, amount withdrawn, and the ledger timestamp.
#[contractevent(topics = ["stream", "withdrawn"], data_format = "vec")]
pub struct StreamWithdrawn {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub timestamp: u64,
}

/// Emitted when a stream is fully settled (topic: `"stream"`, sub-topic: `"settled"`).
///
/// Contains the stream ID, recipient, total amount of the stream, and the
/// ledger timestamp of settlement.
#[contractevent(topics = ["stream", "settled"], data_format = "vec")]
pub struct StreamSettled {
    pub stream_id: u64,
    pub recipient: Address,
    pub total_amount: i128,
    pub timestamp: u64,
}

/// Emitted when an active stream is paused (topic: `"stream"`, sub-topic: `"paused"`).
///
/// Contains the stream ID, the sender who paused it, the pause time, and the
/// ledger timestamp.
#[contractevent(topics = ["stream", "paused"], data_format = "vec")]
pub struct StreamPaused {
    pub stream_id: u64,
    pub sender: Address,
    pub paused_at: u64,
    pub timestamp: u64,
}

/// Emitted when a paused stream is resumed (topic: `"stream"`, sub-topic: `"resumed"`).
///
/// Contains the stream ID, the sender who resumed it, the extended end time,
/// and the ledger timestamp.
#[contractevent(topics = ["stream", "resumed"], data_format = "vec")]
pub struct StreamResumed {
    pub stream_id: u64,
    pub sender: Address,
    pub end_time: u64,
    pub timestamp: u64,
}

/// Emitted when a stream is cancelled (topic: `"stream"`, sub-topic: `"cancelled"`).
///
/// Contains the stream ID, who cancelled it, the amount returned to the
/// sender, the amount released to the recipient, and the ledger timestamp.
#[contractevent(topics = ["stream", "cancelled"], data_format = "vec")]
pub struct StreamCancelled {
    pub stream_id: u64,
    pub cancelled_by: Address,
    pub returned_amount: i128,
    pub released_amount: i128,
    pub timestamp: u64,
}

/// Emitted when a stream is amended (topic: `"stream"`, sub-topic: `"amended"`).
///
/// Contains the stream ID, who amended it, the new rate per second, the new
/// end time, and the ledger timestamp.
#[contractevent(topics = ["stream", "amended"], data_format = "vec")]
pub struct StreamAmended {
    pub stream_id: u64,
    pub amended_by: Address,
    pub new_rate_per_second: i128,
    pub new_end_time: u64,
    pub timestamp: u64,
}

/// Emitted when the contract is upgraded (topic: `"StreamPay"`, sub-topic: `"upgraded"`).
///
/// Contains the new WASM hash of the upgraded contract code.
#[contractevent(topics = ["StreamPay", "upgraded"], data_format = "single-value")]
pub struct ContractUpgraded {
    pub new_wasm_hash: BytesN<32>,
}

/// Emitted for administrative actions on a stream (topic: `"stream"`, sub-topic: `"adminact"`).
///
/// Contains the stream ID, the admin address, a short action symbol, and the
/// ledger timestamp.
#[contractevent(topics = ["stream", "adminact"], data_format = "vec")]
pub struct AdminAction {
    pub stream_id: u64,
    pub admin: Address,
    pub action: Symbol,
    pub timestamp: u64,
}

#[contractevent(topics = ["stream", "deprecated_entrypoint"], data_format = "vec")]
pub struct DeprecatedEntrypoint {
    pub caller: Address,
    pub entrypoint: Symbol,
    pub timestamp: u64,
}

pub fn created(
    env: &Env,
    stream_id: u64,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    total_amount: i128,
    fee_bps: u32,
    duration: u64,
    timestamp: u64,
) {
    StreamCreated {
        stream_id,
        sender: sender.clone(),
        recipient: recipient.clone(),
        token: token.clone(),
        total_amount,
        fee_bps,
        duration,
        timestamp,
    }
    .publish(env);
}

/// Publishes a [`StreamStarted`] event.
pub fn started(env: &Env, stream_id: u64, start_time: u64, end_time: u64, timestamp: u64) {
    StreamStarted {
        stream_id,
        start_time,
        end_time,
        timestamp,
    }
    .publish(env);
}

/// Publishes a [`StreamWithdrawn`] event.
pub fn withdrawn(env: &Env, stream_id: u64, recipient: &Address, amount: i128, timestamp: u64) {
    StreamWithdrawn {
        stream_id,
        recipient: recipient.clone(),
        amount,
        timestamp,
    }
    .publish(env);
}

/// Publishes a [`StreamSettled`] event.
pub fn settled(env: &Env, stream_id: u64, recipient: &Address, total_amount: i128, timestamp: u64) {
    StreamSettled {
        stream_id,
        recipient: recipient.clone(),
        total_amount,
        timestamp,
    }
    .publish(env);
}

pub fn paused(env: &Env, stream_id: u64, sender: &Address, pause_time: u64, timestamp: u64) {
    StreamPaused {
        stream_id,
        sender: sender.clone(),
        paused_at: pause_time,
        timestamp,
    }
    .publish(env);
}

pub fn resumed(env: &Env, stream_id: u64, sender: &Address, end_time: u64, timestamp: u64) {
    StreamResumed {
        stream_id,
        sender: sender.clone(),
        end_time,
        timestamp,
    }
    .publish(env);
}

/// Publishes a [`ContractUpgraded`] event.
pub fn upgraded(env: &Env, new_wasm_hash: BytesN<32>) {
    ContractUpgraded { new_wasm_hash }.publish(env);
}

/// Publishes a [`StreamCancelled`] event.
pub fn cancelled(
    env: &Env,
    stream_id: u64,
    cancelled_by: &Address,
    returned_amount: i128,
    released_amount: i128,
    timestamp: u64,
) {
    StreamCancelled {
        stream_id,
        cancelled_by: cancelled_by.clone(),
        returned_amount,
        released_amount,
        timestamp,
    }
    .publish(env);
}

/// Publishes a [`StreamAmended`] event.
pub fn amended(
    env: &Env,
    stream_id: u64,
    amended_by: &Address,
    new_rate_per_second: i128,
    new_end_time: u64,
    timestamp: u64,
) {
    StreamAmended {
        stream_id,
        amended_by: amended_by.clone(),
        new_rate_per_second,
        new_end_time,
        timestamp,
    }
    .publish(env);
}

/// Publishes an [`AdminAction`] event.
pub fn admin_action(env: &Env, stream_id: u64, admin: &Address, action: Symbol, timestamp: u64) {
    AdminAction {
        stream_id,
        admin: admin.clone(),
        action,
        timestamp,
    }
    .publish(env);
}

/// Emit when a legacy/deprecated contract entrypoint is invoked.
pub fn deprecated_entrypoint(env: &Env, caller: &Address, entrypoint: Symbol, timestamp: u64) {
    DeprecatedEntrypoint {
        caller: caller.clone(),
        entrypoint,
        timestamp,
    }
    .publish(env);
}

/// Emitted when the admin toggles the global pause flag via
/// [`Contract::set_paused`].
pub fn paused_set(env: &Env, admin: &Address, paused: bool, timestamp: u64) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("set_pause")),
        (admin.clone(), paused, timestamp),
    );
}

/// Emitted when the admin role is transferred via [`Contract::set_admin`].
pub fn admin_changed(env: &Env, admin: &Address, new_admin: &Address, timestamp: u64) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("set_admin")),
        (admin.clone(), new_admin.clone(), timestamp),
    );
}

/// Emitted when a token's allowlist status is changed via
/// [`Contract::set_token_allowed`].
pub fn token_allowed_set(
    env: &Env,
    admin: &Address,
    token: &Address,
    allowed: bool,
    timestamp: u64,
) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("set_token")),
        (admin.clone(), token.clone(), allowed, timestamp),
    );
}

/// Emitted when the fee collector address is updated via
/// [`Contract::set_fee_collector`].
pub fn fee_collector_set(env: &Env, admin: &Address, collector: &Address, timestamp: u64) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("set_fee_c")),
        (admin.clone(), collector.clone(), timestamp),
    );
}

/// Emitted when the global default fee bps is updated via
/// [`Contract::set_default_fee_bps`].
pub fn default_fee_bps_set(env: &Env, admin: &Address, fee_bps: u32, timestamp: u64) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("set_dfee")),
        (admin.clone(), fee_bps, timestamp),
    );
}

/// Emitted for every withdrawal that incurs a non-zero fee.
///
/// Topics: `("stream", "fee_charged")`.
/// Data: `(stream_id, fee_amount, fee_bps, collector, timestamp)`.
pub fn fee_charged(
    env: &Env,
    stream_id: u64,
    fee_amount: i128,
    fee_bps: u32,
    collector: &Address,
    timestamp: u64,
) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("fee")),
        (stream_id, fee_amount, fee_bps, collector.clone(), timestamp),
    );
}

/// Emitted when the admin updates the per-user cooloff duration via
/// [`Contract::set_cooloff_duration`].
///
/// Topics: `("stream", "cooloff_set")`.
/// Data: `(admin, duration, timestamp)`.
pub fn cooloff_duration_set(env: &Env, admin: &Address, duration: u64, timestamp: u64) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("cooloff")),
        (admin.clone(), duration, timestamp),
    );
}

/// Emitted when the admin successfully sweeps accumulated protocol fees into
/// the treasury (fee collector address).
///
/// Topics: `("stream", "fees_swept")`.
/// Data: `(streams_swept, total_amount, collector, caller, timestamp)`.
///
/// | Field           | Type      | Description                                        |
/// |-----------------|-----------|----------------------------------------------------|
/// | `streams_swept` | `u32`     | Number of streams that had a non-zero fee balance. |
/// | `total_amount`  | `i128`    | Total tokens transferred to the fee collector.     |
/// | `collector`     | `Address` | Destination of the swept funds.                    |
/// | `caller`        | `Address` | Admin address that initiated the sweep.            |
/// | `timestamp`     | `u64`     | Ledger timestamp at the time of the sweep.         |
pub fn fees_swept(
    env: &Env,
    streams_swept: u32,
    total_amount: i128,
    collector: &Address,
    caller: &Address,
    timestamp: u64,
) {
    env.events().publish(
        (symbol_short!("stream"), symbol_short!("swept")),
        (
            streams_swept,
            total_amount,
            collector.clone(),
            caller.clone(),
            timestamp,
        ),
    );
}
