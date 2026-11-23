# Contract Storage Layout

This document describes the on-chain storage keys, data structures, and TTL
(time-to-live) tiers used by the `streampay-stream` Soroban contract. It is the
canonical reference for the storage model and must be kept in sync with the
source files under `contracts/contracts/streampay-stream/src/`.

- [Storage tiers](#storage-tiers)
- [Data structures](#data-structures)
- [Key catalog](#key-catalog)
  - [Instance storage](#instance-storage)
  - [Persistent storage](#persistent-storage)
- [TTL tiers](#ttl-tiers)
- [Invariants](#invariants)

## Storage tiers

Soroban exposes three storage durabilities. The contract uses two of them:

| Tier           | Used for                                              | Lifetime                                            |
| -------------- | ----------------------------------------------------- | --------------------------------------------------- |
| **Instance**   | Singletons that share the contract instance's TTL.    | Extended as a group whenever the instance is bumped. |
| **Persistent** | Per-stream, per-sender, and per-token rows that outlive the instance. | Extended individually on every read/write.          |

Temporary storage is intentionally not used: no contract state may silently
disappear between ledgers.

## Data structures

### `Stream` (`storage.rs`)

```rust
pub struct Stream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub duration: u64,
    pub last_update: u64,
    pub status: StreamStatus,
    pub paused_at: u64,
    pub total_paused_duration: u64,
    pub fee_bps: u32,
}
```

On-chain record for a single linear-vesting payment stream. Each stream escrows
`total_amount` from `sender` and releases it linearly to `recipient` from
`start_time` to `end_time`. The fee is applied to every withdrawal at
`fee_bps` basis points.

### `SplitStream` (`multi.rs`)

```rust
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
```

Multi-recipient split stream. Each recipient has a `RecipientAllocation` with
a proportional `weight` and individual `released_amount`.

### `RecurringStream` (`recurring.rs`)

```rust
pub struct RecurringStream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount_per_cycle: i128,
    pub cycle_duration: u64,
    pub total_cycles: u64,
    pub cycles_completed: u64,
    pub withdrawn_amount: i128,
    pub start_time: u64,
    pub last_processed_time: u64,
    pub status: StreamStatus,
    pub paused_at: u64,
    pub total_paused_duration: u64,
    pub fee_bps: u32,
}
```

Periodic payment stream. Releases `amount_per_cycle` each `cycle_duration`
seconds for `total_cycles` cycles.

### `StreamStatus` (`storage.rs`)

```rust
pub enum StreamStatus {
    Draft,
    Active,
    Paused,
    Settled,
    Ended,
    Cancelled,
}
```

Lifecycle status shared by all stream types.

### `PendingUpgrade` (`upgrade.rs`)

```rust
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub execute_after: u64,
}
```

A proposed WASM upgrade waiting out the timelock.

### `StorageVersion` (`migrate.rs`)

```rust
pub struct StorageVersion {
    pub version: u32,
}
```

Schema version marker for the contract's persistent data layout.

### `CpuMetric` (`instrument.rs`)

```rust
pub struct CpuMetric {
    pub entrypoint: Symbol,
    pub total_cpu: u64,
    pub call_count: u64,
    pub max_cpu: u64,
    pub last_updated: u64,
}
```

Per-entrypoint CPU usage metrics for performance monitoring.

### `RecipientAllocation` (`multi.rs`)

```rust
pub struct RecipientAllocation {
    pub recipient: Address,
    pub weight: u64,
    pub released_amount: i128,
}
```

Single recipient within a `SplitStream`.

## Key catalog

### Instance storage

Instance-storage keys live for the lifetime of the contract instance and are
extended together as a group.

| Key | Enum | Value | Source module | Purpose |
|-----|------|-------|---------------|---------|
| `Admin` | `DataKey` | `Address` | `storage.rs` | Governance address authorised for admin entrypoints. |
| `Paused` | `DataKey` | `bool` | `storage.rs` | Global pause guard checked by state-changing calls. |
| `StreamCount` | `DataKey` | `u64` | `storage.rs` | Monotonic counter; source of the next stream id. |
| `FeeBps` | `DataKey` | `u32` | `storage.rs` | Protocol-level fee in basis points (0–10 000). |
| `AdminNonce` | `AdminKey` | `u64` | `admin.rs` | Replay-protection nonce for `admin_override`. Starts at `0`, incremented on each use. |
| `LastActionTime` | `AdminKey` | `u64` | `admin.rs` | Ledger timestamp of the last successful admin action (cooldown enforcement). |
| `DefaultFeeBps` | `FeeDataKey` | `u32` | `fees.rs` | Global default `fee_bps` applied when a stream has no per-stream override. Defaults to `0`. |
| `FeeCollector` | `FeeDataKey` | `Address` | `fees.rs` | Address that receives collected protocol fees. |
| `Pending` | `UpgradeKey` | `PendingUpgrade` | `upgrade.rs` | In-flight upgrade proposal (two-step timelock). |
| `StorageVersion` | `VersionKey` | `StorageVersion` | `migrate.rs` | Schema version marker; `0` = pre-migration, `1` = current. |
| `MaxStreamsPerSender` | `LimitDataKey` | `u64` | `limits.rs` | Configurable cap on active streams per sender. Defaults to `10`. |
| `CooloffDuration` | `CooloffKey` | `u64` | `cooloff.rs` | Per-user cooloff duration in seconds. `0` = no cooloff enforced. |
| `NextRecurringId` | `RecurDataKey` | `u64` | `recurring.rs` | Monotonic counter for recurring stream IDs. |
| `NextSplitStreamId` | `SplitDataKey` | `u64` | `multi.rs` | Monotonic counter for split stream IDs. |
| `CpuMetricCount` | `InstrumentKey` | (counter) | `instrument.rs` | Number of tracked entrypoints for CPU metrics. |

### Persistent storage

Persistent-storage keys are extended individually each time they are read or
written. They can outlive the instance.

| Key | Enum | Value | Source module | Purpose |
|-----|------|-------|---------------|---------|
| `Stream(u64)` | `DataKey` | `Stream` | `storage.rs` | A single linear-vesting stream row, keyed by stream id. |
| `TokenAllowed(Address)` | `DataKey` | `bool` | `storage.rs` | Per-token allow/deny entry. Absent ⇒ token is allowed. |
| `WithdrawerAllowlist(u64)` | `DataKey` | `Vec<Address>` | `storage.rs` | Per-stream list of authorised withdrawer addresses. |
| `SenderStreamCount(Address)` | `LimitDataKey` | `u64` | `limits.rs` | Live count of active streams for one sender address. |
| `StreamFeeBps(u64)` | `FeeDataKey` | `u32` | `fees.rs` | Per-stream `fee_bps` override written at creation time. |
| `AccumulatedFees(u64)` | `FeeDataKey` | `i128` | `fees.rs` | Accumulated (un-swept) protocol fee balance for a stream. |
| `CooloffUntil(Address)` | `CooloffKey` | `u64` | `cooloff.rs` | Timestamp until which sender is blocked from creating new streams. |
| `Token(Address, Address)` | `OrgAllowKey` | `bool` | `allowlist.rs` | Per-org token allow/deny entry for an `(org, token)` pair. |
| `Enabled(Address)` | `OrgAllowKey` | `bool` | `allowlist.rs` | Marker set once an org has enabled allowlist enforcement. |
| `RecurringStream(u64)` | `RecurDataKey` | `RecurringStream` | `recurring.rs` | A single recurring stream row, keyed by recurring stream id. |
| `SplitStream(u64)` | `SplitDataKey` | `SplitStream` | `multi.rs` | A single split stream row, keyed by split stream id. |
| `CpuMetric(Symbol)` | `InstrumentKey` | `CpuMetric` | `instrument.rs` | Per-entrypoint CPU usage metrics. |

## TTL tiers

TTLs are expressed in ledger sequences (~5s per ledger on mainnet). Each tier
defines a *minimum remaining* threshold and an *extend-to* target: when an entry
is touched and its remaining TTL falls below the threshold, it is bumped back up
to the target.

### Instance-storage TTL

All instance-storage keys share a single TTL that is extended as a group:

| Key group | Min remaining | Extend to | Approx. window | Source |
|-----------|---------------|-----------|----------------|--------|
| Instance keys (admin, paused, counters, config) | `120_960` | `518_400` | ~1 week → ~1 month | `storage.rs`, `admin.rs`, `fees.rs`, `limits.rs`, `cooloff.rs`, `recurring.rs`, `multi.rs` |

### Persistent-storage TTL

| Tier | Min remaining | Extend to | Approx. window | Source |
|------|---------------|-----------|----------------|--------|
| Stream / Recurring / Split rows | `241_920` | `1_555_200` | ~2 weeks → ~3 months | `storage.rs` |
| Per-stream fee bps entries | `241_920` | `1_555_200` | ~2 weeks → ~3 months | `fees.rs` |
| Accumulated fee balances | `241_920` | `1_555_200` | ~2 weeks → ~3 months | `fees.rs` |
| Per-sender stream counters | `241_920` | `1_555_200` | ~2 weeks → ~3 months | `limits.rs` |
| Per-sender cooloff entries | `241_920` | `1_555_200` | ~2 weeks → ~3 months | `cooloff.rs` |
| Token allowlist entries | `120_960` | `518_400` | ~1 week → ~1 month | `storage.rs` |
| Fee configuration keys | `120_960` | `518_400` | ~1 week → ~1 month | `fees.rs` |

### TTL constants reference

| Constant | Value | Approx. window | Defined in |
|----------|-------|----------------|------------|
| `STREAM_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `storage.rs:107` |
| `STREAM_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `storage.rs:108` |
| `INSTANCE_TTL_MIN_REMAINING` | `120_960` | ~1 week | `storage.rs:109` |
| `INSTANCE_TTL_EXTEND_TO` | `518_400` | ~1 month | `storage.rs:110` |
| `TOKEN_TTL_MIN_REMAINING` | `120_960` | ~1 week | `storage.rs:116` |
| `TOKEN_TTL_EXTEND_TO` | `518_400` | ~1 month | `storage.rs:117` |
| `NONCE_TTL_MIN_REMAINING` | `120_960` | ~1 week | `admin.rs:76` |
| `NONCE_TTL_EXTEND_TO` | `518_400` | ~1 month | `admin.rs:77` |
| `INSTANCE_TTL_MIN_REMAINING` (fees) | `120_960` | ~1 week | `fees.rs:55` |
| `INSTANCE_TTL_EXTEND_TO` (fees) | `518_400` | ~1 month | `fees.rs:57` |
| `STREAM_FEE_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `fees.rs:59` |
| `STREAM_FEE_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `fees.rs:61` |
| `ACCUM_FEE_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `fees.rs:64` |
| `ACCUM_FEE_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `fees.rs:66` |
| `SENDER_COUNT_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `limits.rs:12` |
| `SENDER_COUNT_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `limits.rs:13` |
| `INSTANCE_TTL_MIN_REMAINING` (limits) | `120_960` | ~1 week | `limits.rs:18` |
| `INSTANCE_TTL_EXTEND_TO` (limits) | `518_400` | ~1 month | `limits.rs:19` |
| `COOLOFF_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `cooloff.rs:38` |
| `COOLOFF_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `cooloff.rs:39` |
| `INSTANCE_TTL_MIN_REMAINING` (cooloff) | `120_960` | ~1 week | `cooloff.rs:43` |
| `INSTANCE_TTL_EXTEND_TO` (cooloff) | `518_400` | ~1 month | `cooloff.rs:44` |
| `RECUR_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `recurring.rs:93` |
| `RECUR_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `recurring.rs:94` |
| `SPLIT_TTL_MIN_REMAINING` | `241_920` | ~2 weeks | `multi.rs:49` |
| `SPLIT_TTL_EXTEND_TO` | `1_555_200` | ~3 months | `multi.rs:50` |

## Invariants

- **Stream ids start at `1`** and increase monotonically; ids are never reused.
- **Reading or writing a stream extends its TTL**, so active streams stay alive.
- **Token allowlist is allow-by-default**: a token is blocked only when an
  explicit `TokenAllowed(addr) = false` entry exists.
- **Per-org allowlist is opt-in**: an org is unrestricted until it sets its
  first explicit allow entry.
- **Sender counters are reference-counted**: incremented on stream creation and
  decremented when a stream leaves the active set, never dropping below zero.
- **Admin nonce strictly increases**: each `admin_override` call consumes the
  current nonce and advances it by one, preventing replay attacks.
- **Admin actions are rate-limited**: at most one admin override per 24 hours
  (`ADMIN_COOLDOWN_SECONDS`).
- **Upgrades are timelocked**: a minimum 48-hour delay between proposal and
  execution (`TIMELOCK_SECONDS`).
- **Migrations are one-way**: once a contract is migrated to version N, there
  is no supported path back to version N−1.
- **All arithmetic is checked**: the contract uses `checked_add`, `checked_sub`,
  `checked_mul`, and `checked_div` to prevent overflows. No `unwrap()` or
  `expect()` calls exist in production paths.
