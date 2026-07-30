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
| `create_stream` | Yes | `sender` | Creates a stream and escrows funds from the sender. |
| `start_stream` | Yes | `stream.sender` | Activates a draft stream, anchoring its time bounds. |
| `pause` | Yes | `stream.sender` | Freezes accrual for an active stream. |
| `resume` | Yes | `stream.sender` | Resumes a paused stream, extending the end time. |
| `cancel_stream` | Yes | `stream.sender` | Ends a stream early, refunding unvested funds to sender. |
| `withdraw` | Yes | `stream.recipient` | Withdraws vested funds to the recipient. |
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
| `set_cooloff_duration` | Yes | `admin` | Sets the per-user cooloff duration (in seconds) between stream creations. |
| `get_cooloff_duration` | No | None | Returns the current per-user cooloff duration in seconds. |
| `get_cooloff_until` | No | None | Returns the timestamp until which a sender is blocked by cooloff. |

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
| `settled`   | `withdraw` (full) or `settle` | `stream_id`, `recipient`, `total_amount`, `timestamp` |
| `cancelled` | `cancel_stream`       | `stream_id`, `cancelled_by`, `returned_amount`, `released_amount`, `timestamp` |
| `amended`   | `amend_stream`        | `stream_id`, `amended_by`, `new_rate_per_second`, `new_end_time`, `timestamp` |
| `upgraded`  | `upgrade`             | `new_wasm_hash` (topics: `"StreamPay"/"upgraded"`) |
| `cooloff_duration_set` | `set_cooloff_duration` | `admin`, `duration`, `timestamp` (topics: `"stream"/"cooloff"`) |

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
