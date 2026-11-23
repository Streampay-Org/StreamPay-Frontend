# StreamPay Stream Smart Contract

Linear payment streams on Stellar/Soroban.

## Entrypoints

| Entrypoint | Mutating | Required Authorizer | Description |
| :--- | :--- | :--- | :--- |
| `initialize` | Yes | `admin` | Initialises the contract with an admin and pause state. |
| `init_with_token_allowlist` | Yes | `admin` | Atomic deployment-time initialisation + per-token allowlist; equivalent to `initialize` followed by one `set_token_allowed(allowed = true)` per token, committed in a single transaction. |
| `set_paused` | Yes | `admin` | Sets the global emergency pause flag. |
| `set_admin` | Yes | `admin` | Transfers the admin role to a new address. |
| `set_token_allowed` | Yes | `admin` | Allows or blocks a token for future stream creation. |
| `create_stream` | Yes | `sender` | Creates a stream and escrows funds from the sender (no cliff; `cliff_time = 0`). |
| `create_stream_with_cliff` | Yes | `sender` | Creates a stream with an optional `cliff_time` (`0` = no cliff, or `start_time <= cliff_time <= end_time`); vested amount is `0` before the cliff and jumps to linear accrual at/after the cliff. |
| `start_stream` | Yes | `stream.sender` | Activates a draft stream, anchoring its time bounds. |
| `pause` | Yes | `stream.sender` | Freezes accrual for an active stream. |
| `resume` | Yes | `stream.sender` | Resumes a paused stream, extending the end time. |
| `cancel_stream` | Yes | `stream.sender` | Ends a stream early, refunding unvested funds to sender. |
| `withdraw` | Yes | `stream.recipient` | Withdraws vested funds to the recipient. |
| `withdraw_to` | Yes | `stream.recipient` | Withdraws vested funds to a custom destination address (recipient-only auth, destination trustline checked). |
| `propose_recipient_transfer` | Yes | `stream.recipient` | Proposes transferring the stream's recipient role to a new address (step 1 of two-step transfer). |
| `accept_recipient_transfer` | Yes | `pending_recipient` | Accepts a pending recipient transfer, updating `stream.recipient` and clearing the previous withdrawer allowlist (step 2). |
| `cancel_recipient_transfer` | Yes | `stream.recipient` or `stream.sender` | Cancels a pending recipient transfer proposal before acceptance. |
| `get_pending_recipient` | No | None | Returns the pending recipient transfer target for a stream, if any. |
| `settle` | Yes | `stream.recipient` | Ends a stream and releases all remaining funds to recipient. |
| `get_stream` | No | None | Returns the stream record. |
| `withdrawable` | No | None | Returns the currently withdrawable amount. |
| `claim_drip` | No | None | Returns the unsettled accrual (vested minus released) — a convenience alias for `withdrawable`. |
| `stream_balance` | No | None | Returns the vested balance at the current time. |
| `stream_snapshot` | No | None | Captures a `StreamSnapshot` (vested, released, locked, withdrawable, status) at a given ledger timestamp. |
| `diff_snapshots` | No | None | Computes the field-by-field `SnapshotDiff` delta between two `StreamSnapshot` values from the same stream. |
| `list_streams` | No | None | Returns a paginated page of all streams ordered by ID. |
| `list_streams_by_sender` | No | None | Returns a paginated page of streams filtered by sender address. |
| `list_streams_by_recipient` | No | None | Returns a paginated page of streams filtered by recipient address. |
| `list_streams_by_status` | No | None | Returns a paginated page of streams filtered by status. |
| `list_streams_recipient_status` | No | None | Returns a paginated page of streams filtered by recipient and status (compound). |
| `list_streams_sender_status` | No | None | Returns a paginated page of streams filtered by sender and status (compound). |
| `list_split_streams_by_recipient` | No | None | Returns a paginated page of split streams containing the given recipient address. |
| `list_recurring_by_sender` | No | None | Returns a paginated page of recurring streams filtered by sender address. |
| `create_split_stream` | Yes | `sender` | Creates a weighted multi-recipient split stream and escrows `total_amount` from `sender`. |
| `withdraw_split` | Yes | `recipient` | Withdraws vested funds for a specific allocated recipient from a split stream. |
| `pause_split_stream` | Yes | `stream.sender` | Freezes accrual for an active split stream across all recipients. |
| `resume_split_stream` | Yes | `stream.sender` | Resumes a paused split stream, extending `end_time` by the paused span. |
| `cancel_split_stream` | Yes | `stream.sender` | Cancels a split stream, paying vested-but-unreleased shares to recipients and refunding the remainder to `sender`. |
| `get_split_stream` | No | None | Returns the `SplitStream` record (including recipients, weights, and cumulative releases). |
| `split_withdrawable` | No | None | Returns the currently withdrawable amount for a specific recipient in a split stream. |
| `split_stream_balance` | No | None | Returns the total vested amount for a split stream at the current ledger timestamp. |
| `create_recurring_stream` | Yes | `sender` | Creates a periodic recurring stream and escrows `amount_per_cycle * total_cycles` from `sender`. |
| `process_recurring_stream` | Yes | None (permissionless) | Advances `cycles_completed` based on elapsed time; transitions to `Ended` when all cycles complete. |
| `withdraw_recurring` | Yes | `recipient` | Withdraws vested funds from a recurring stream to `stream.recipient`. |
| `pause_recurring_stream` | Yes | `stream.sender` | Freezes cycle accrual for an active recurring stream. |
| `resume_recurring_stream` | Yes | `stream.sender` | Resumes a paused recurring stream, excluding the pause span from vesting. |
| `cancel_recurring_stream` | Yes | `stream.sender` | Cancels a recurring stream, returning unvested escrow to `sender` and topping up vested-but-unwithdrawn funds to `recipient`. |
| `get_recurring_stream` | No | None | Returns the `RecurringStream` record. |
| `recurring_withdrawable` | No | None | Returns the currently withdrawable amount (`vested - withdrawn_amount`) for a recurring stream. |
| `recurring_vested` | No | None | Returns the total vested amount across all completed cycles for a recurring stream. |
| `set_cooloff_duration` | Yes | `admin` | Sets the per-user cooloff duration (in seconds) between stream creations. |
| `get_cooloff_duration` | No | None | Returns the current per-user cooloff duration in seconds. |
| `get_cooloff_until` | No | None | Returns the timestamp until which a sender is blocked by cooloff. |
| `set_dormancy_grace` | Yes | `admin` | Sets the global dormant-stream grace period in seconds (`0` = disabled). |
| `get_dormancy_grace` | No | None | Returns the current dormant-stream grace period in seconds (`0` = disabled). |
| `sweep_dormant_stream` | Yes | `stream.sender` | Reclaims unclaimed vested funds from a dormant stream back to the sender and marks it `Settled`. |
| `set_fee_collector` | Yes | `admin` | Sets the address that receives protocol fees. |
| `set_default_fee_bps` | Yes | `admin` | Sets the global default protocol fee in basis points. |
| `get_default_fee_bps` | No | None | Returns the global default protocol fee. |
| `set_token_fee_bps` | Yes | `admin` | Sets a per-token protocol fee override. |
| `clear_token_fee_bps` | Yes | `admin` | Removes a per-token protocol fee override. |
| `get_token_fee_bps` | No | None | Returns the per-token override, or `null` when unset. |
| `get_stream_fee_bps` | No | None | Returns the effective fee for a stream after precedence resolution. |

## Protocol fees

Fees are charged on withdrawal in basis points (`1 bps = 0.01%`, maximum
`10_000`). The effective fee for a stream is resolved in this order:

1. the explicit per-stream `fee_bps` passed to `create_stream`, when non-zero;
2. the per-token override set with `set_token_fee_bps`;
3. the global default set with `set_default_fee_bps` (zero unless configured).

A stream created with a non-zero `fee_bps` keeps that value for its whole life.
Setting a token override later never rewrites an existing stream's stored
`fee_bps`. A stream created with `fee_bps = 0` carries no per-stream fee, so it
follows the token override and then the global default. A per-token override of
`0` makes that token fee-free even when the default is non-zero.

If no fee collector is configured, no fee is charged and the full withdrawn
amount goes to the recipient.

### Fee behaviour by stream type

| Stream path | Fee behaviour | Implementation |
| :--- | :--- | :--- |
| **Standard streams** | Resolves effective fee via `fees::resolve_stream_fee_bps` (per-stream `fee_bps` → per-token override → global default) and deducts it with `fees::apply_fee` when `fees::get_fee_collector` is set. | `Contract::withdraw`, `Contract::withdraw_to`, `execute_withdraw` (`src/lib.rs`) |
| **Recurring streams** | Applies `fees::apply_fee(amount, stream.fee_bps)` directly using the stream's own `fee_bps` stored at `recurring::create` (does **not** fall back to token overrides or global defaults). Transfers `fee_amount` to the collector when `fees::get_fee_collector` is `Some`, otherwise pays the full `amount` to `recipient`. No fee is deducted on `recurring::cancel`. | `recurring::withdraw` (`src/recurring.rs`) |
| **Split streams** | **No protocol fees are charged.** `multi::withdraw_split` transfers the full `amount` directly to the recipient without calling `fees::apply_fee`, and `SplitStream` carries no `fee_bps` field. | `multi::withdraw_split` (`src/multi.rs`) |

## Split streams

A split stream (`SplitStream` in `src/multi.rs`) escrows a single `total_amount`
on-chain and streams it linearly across multiple recipients according to
integer weights.

- **Recipients & weights:** `create_split_stream` requires at least 2 recipients,
  `recipients.len() == weights.len()`, every `weight > 0`, no recipient equal to
  `sender`, and a valid token trustline for each recipient. `total_weight` is the
  checked sum of all recipient weights.
- **Per-recipient vesting:** Total stream vesting (`split_vested_amount`) accrues
  linearly over `duration = end_time - start_time` (excluding
  `total_paused_duration`, and frozen at `pause_time` while `Paused`). Each
  recipient's vested share (`recipient_vested`) is computed with integer division
  as `total_vested * weight / total_weight`, and their withdrawable balance is
  `max(0, recipient_vested - alloc.released_amount)`.
- **Settle condition:** In `multi::withdraw_split`, the stream transitions to
  `StreamStatus::Settled` once `stream.total_released == stream.total_amount`.
- **Pause, resume, and cancel:** Only `stream.sender` may call
  `pause_split_stream`, `resume_split_stream` (which extends `end_time` by the
  paused span), or `cancel_split_stream`. Cancellation pays each recipient their
  vested-but-unreleased share and refunds the remaining escrow (unvested funds
  plus any integer-division rounding remainder) to `sender`.

> **Note:** For the HTTP v2 multi-recipient fan-out API (which creates one
> standard stream per recipient rather than a single on-chain `SplitStream`),
> see [`docs/api/multi-recipient-stream.md`](../../../docs/api/multi-recipient-stream.md).

## Recurring streams

A recurring stream (`RecurringStream` in `src/recurring.rs`) lets a sender
pre-fund a periodic schedule of `total_cycles` fixed payments of
`amount_per_cycle` every `cycle_duration` seconds.

- **Escrow & cycles:** `create_recurring_stream` escrows
  `amount_per_cycle * total_cycles` up front in `Active` status. Completed
  cycles (`vested_cycles`) advance discretely as
  `min(elapsed / cycle_duration, total_cycles)`, where `elapsed` excludes
  `total_paused_duration` and freezes at `paused_at` while `Paused`.
- **Permissionless processing:** `process_recurring_stream` (`recurring::process`)
  requires **no authorization** — any keeper may call it on an `Active` or
  `Paused` stream to advance `cycles_completed` and transition the stream to
  `Ended` once `cycles_completed >= total_cycles`.
- **Withdrawals, pause, and resume:** `withdraw_recurring` requires
  `stream.recipient` authorization and transfers vested-minus-withdrawn funds
  (applying `stream.fee_bps` as described above). `pause_recurring_stream` and
  `resume_recurring_stream` require `stream.sender` authorization; already-vested
  cycles remain processable and withdrawable while paused.
- **Cancellation refund:** `cancel_recurring_stream` (`recurring::cancel`)
  requires `stream.sender` authorization. Unvested escrow
  (`min(total_escrow - vested, remaining_in_contract)`) is refunded to `sender`,
  and any remaining vested-but-unwithdrawn balance (`recipient_top_up`) is
  transferred to `recipient`.

## Paginated Stream Enumeration

All `list_streams*` entrypoints share the same cursor-based pagination contract:

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_after` | `Option<u64>` | Exclusive cursor: return streams with `id > start_after`. Pass `None` to start from stream ID 1. |
| `limit` | `u64` | Maximum results to return. Capped at 100 ([`MAX_PAGE_SIZE`]). |

**Return type — `StreamPage`:**

```
StreamPage {
    streams:     Vec<Stream>,   // ordered by ascending stream ID
    next_cursor: Option<u64>,   // None → last page; Some(id) → pass as start_after
}
```

**Paginating through all streams:**

```rust
let mut cursor: Option<u64> = None;
loop {
    let page = client.list_streams(&cursor, &20);
    for stream in page.streams.iter() { /* ... */ }
    cursor = page.next_cursor;
    if cursor.is_none() { break; }
}
```

View functions:
- Never require auth.
- Are never blocked by the global pause flag.
- Never mutate state or extend TTLs (reads use `peek_next_stream_id` which is side-effect-free).
- Are bounded by `MAX_PAGE_SIZE = 100` to prevent excessive resource use.

## Lifecycle events

All state-changing entrypoints emit a structured Soroban contract event
**after** the successful mutation and any token transfer. Failed calls emit
no events.

Every stream-level event uses a two-topic layout:

```
topic[0] = Symbol("stream")
topic[1] = Symbol("<event_name>")
data     = vec-encoded payload fields
```

| Event | Emitted by | Payload fields |
|-------|-----------|----------------|
| `created`   | `create_stream`       | `stream_id`, `sender`, `recipient`, `token`, `total_amount`, `timestamp` |
| `started`   | `start_stream`        | `stream_id`, `start_time`, `end_time`, `timestamp` |
| `paused`    | `pause`               | `stream_id`, `sender`, `pause_time`, `timestamp` |
| `resumed`   | `resume`              | `stream_id`, `sender`, `end_time`, `timestamp` |
| `withdrawn` | `withdraw`            | `stream_id`, `recipient`, `amount`, `timestamp` |
| `withdrawn_to` | `withdraw_to`      | `stream_id`, `recipient`, `destination`, `amount`, `timestamp` |
| `settled`   | `withdraw` / `withdraw_to` (full) or `settle` | `stream_id`, `recipient`, `total_amount`, `timestamp` |
| `cancelled` | `cancel_stream`       | `stream_id`, `cancelled_by`, `returned_amount`, `released_amount`, `timestamp` |
| `amended`   | `amend_stream`        | `stream_id`, `amended_by`, `new_rate_per_second`, `new_end_time`, `timestamp` |
| `upgraded`  | `upgrade`             | `new_wasm_hash` (topics: `"StreamPay"/"upgraded"`) |
| `cooloff_duration_set` | `set_cooloff_duration` | `admin`, `duration`, `timestamp` (topics: `"stream"/"cooloff"`) |
| `split_cr` (`SplitStreamCreated`) | `create_split_stream` | `stream_id`, `sender`, `token`, `total_amount`, `timestamp` (topics: `"stream"/"split_cr"`) |
| `split_wd` (`SplitStreamWithdrawn`) | `withdraw_split` | `stream_id`, `recipient`, `amount`, `timestamp` (topics: `"stream"/"split_wd"`) |
| `split_ca` (`SplitStreamCancelled`) | `cancel_split_stream` | `stream_id`, `cancelled_by`, `returned_amount`, `released_amount`, `timestamp` (topics: `"stream"/"split_ca"`) |
| `split_pa` (`SplitStreamPaused`) | `pause_split_stream` | `stream_id`, `sender`, `paused_at`, `timestamp` (topics: `"stream"/"split_pa"`) |
| `split_re` (`SplitStreamResumed`) | `resume_split_stream` | `stream_id`, `sender`, `end_time`, `timestamp` (topics: `"stream"/"split_re"`) |
| `created` (`RecurringCreated`) | `create_recurring_stream` | `stream_id`, `sender`, `recipient`, `token`, `amount_per_cycle`, `total_cycles`, `cycle_duration`, `fee_bps`, `timestamp` (topics: `"recurring"/"created"`) |
| `processed` (`RecurringProcessed`) | `process_recurring_stream` | `stream_id`, `cycles_completed`, `timestamp` (topics: `"recurring"/"processed"`) |
| `withdrawn` (`RecurringWithdrawn`) | `withdraw_recurring` | `stream_id`, `recipient`, `amount`, `timestamp` (topics: `"recurring"/"withdrawn"`) |
| `cancelled` (`RecurringCancelled`) | `cancel_recurring_stream` | `stream_id`, `cancelled_by`, `returned_amount`, `withdrawn_amount`, `timestamp` (topics: `"recurring"/"cancelled"`) |
| `paused` (`RecurringPaused`) | `pause_recurring_stream` | `stream_id`, `sender`, `timestamp` (topics: `"recurring"/"paused"`) |
| `resumed` (`RecurringResumed`) | `resume_recurring_stream` | `stream_id`, `sender`, `timestamp` (topics: `"recurring"/"resumed"`) |

When a `withdraw` fully drains the stream it emits two events in order:
`withdrawn` then `settled`.

Admin utility events (`set_pause`, `set_admin`, `set_token`) use
`symbol_short!` two-tuples — see `src/events.rs` for the exact encoding.

## Development

```bash
# Build
cargo build --target wasm32-unknown-unknown --release

# Test
cargo test

# Coverage gate (≥ 95 % lines / regions / functions)
make coverage
```

## CI gas budget gate

The repository now includes a dedicated GitHub Actions gate at
`.github/workflows/gas.yml` for the GrantFox campaign.  The job compiles the
criterion benchmark harness and then compares the optimized WASM footprint
against the budget manifest at `contracts/gas-budget.json`.

The gate is intentionally conservative:

- it uses a stable, deterministic build path;
- it compares the current optimized WASM size to a checked-in baseline;
- it fails when the contract grows by more than `5%`.

Reviewers should update `contracts/gas-budget.json` only when they are
intentionally changing the contract footprint and have confirmed the new
size budget is still acceptable.

## Benchmark harness

Criterion benchmarks live in `benches/entrypoints.rs`.  There is one
`BenchmarkGroup` per public entrypoint; each group has sub-benchmarks for
representative pre-conditions (e.g. partial vs. full withdrawal).

The Soroban in-process test host is used so results are stable and
deterministic — no network or ledger overhead.

```bash
# Build the benchmark binary without running it (also what CI does)
make bench-compile

# Run all groups and open the HTML report
make bench
open target/criterion/report/index.html

# Run a single group (substring match)
make bench-withdraw
make bench-create
make bench-read      # get_stream, withdrawable, stream_balance, ...
make bench-lifecycle # pause, resume, settle, cancel_stream, amend_stream
make bench-admin     # initialize, set_paused, set_admin, ...

# Save a baseline before a refactor, then compare afterwards
make bench-baseline NAME=before-refactor
# ... make changes ...
make bench-compare  NAME=before-refactor
```

**Reading results:** Criterion reports a lower/upper confidence interval for
each measurement.  A red regression flag in the HTML report means the new run
is statistically slower at the configured confidence level (95 %).  Run
benchmarks on a quiet machine — shared CI runners have high timing variance.

| Group | Sub-benchmark | What is measured |
| :--- | :--- | :--- |
| `initialize` | `initialize` | Admin write + paused-flag write |
| `init_with_token_allowlist` | `three_tokens` | Admin + 3 × allowlist writes |
| `set_paused` | `pause` / `unpause` | Admin lookup + flag write |
| `set_admin` | `set_admin` | Admin lookup + key overwrite |
| `set_token_allowed` | `allow` / `block` | Admin lookup + allowlist write |
| `set_max_streams_per_sender` | `set_max_streams_per_sender` | Admin lookup + instance write |
| `max_streams_per_sender` | `max_streams_per_sender` | Single instance read |
| `sender_stream_count` | `zero_streams` / `one_stream` | Single persistent read |
| `get_stream` | `get_stream` | Persistent read + TTL extend |
| `withdrawable` | `at_midpoint` / `at_end` | Linear-interpolation math |
| `stream_balance` | `at_midpoint` / `at_end` | Vested-amount calculation |
| `create_stream` | `create_stream` | Token transfer + stream write + event |
| `start_stream` | `start_stream` | Stream read + timestamp write + event |
| `withdraw` | `partial` / `full_settle` | Token transfer + stream write + events |
| `pause` | `pause` | Stream read + status write + event |
| `resume` | `resume` | Stream read + checked arithmetic + write |
| `settle` | `full_payout` / `zero_payout` | Token transfer (optional) + finalization |
| `cancel_stream` | `mid_stream` / `at_start` | Token return + stream finalization |
| `amend_stream` | `extend_end_time` | Stream read + end-time update + event |
