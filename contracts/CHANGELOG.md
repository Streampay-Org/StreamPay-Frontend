# StreamPay contract changelog

This changelog tracks user-visible changes to the Soroban contract
under `contracts/contracts/streampay-stream/`. Backend changes are
tracked in the repository-root `CHANGELOG.md`.

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Discriminant numbers in `error.rs` are part of the public contract API
and must never be reused — see the module rustdoc for details.

## [Unreleased]

### Added
- **Optional cliff vesting (`cliff_time`).** `Stream` now includes
  `cliff_time: u64` (`0` = no cliff) and an additive
  `create_stream_with_cliff` entrypoint (preserving ABI compatibility for
  `create_stream`). When `cliff_time > 0`, it must satisfy
  `start_time <= cliff_time <= end_time` (otherwise `InvalidTimeRange` is
  returned); `vested_amount` / `withdrawable` return `0` until active elapsed
  time reaches `cliff_time - start_time`, at which point vesting jumps to the
  linear accrued amount and still reaches `total_amount` at `end_time`.
  `StreamCreated` now includes `cliff_time`, and `migrate` advances storage to
  version `3` by initialising `cliff_time = 0` on pre-existing streams.
- **Two-step recipient transfer.** Added `propose_recipient_transfer`,
  `accept_recipient_transfer`, `cancel_recipient_transfer`, and
  `get_pending_recipient` to safely rotate a stream's recipient address.
  The current recipient proposes a new recipient (rejecting self-transfer,
  sender-as-recipient, missing trustline, and terminal streams; overwriting any
  prior proposal), the proposed address accepts (updating `stream.recipient`,
  clearing the proposal and previous withdrawer allowlist, and preserving
  already-released amounts and fee accounting), and either the current recipient
  or sender can cancel before acceptance. Appended `Error::NoPendingTransfer = 26`
  and added `recipient_transfer_proposed`, `recipient_transfer_accepted`, and
  `recipient_transfer_cancelled` events.
- **Dormant-stream expiry sweeping.**
  - Admin-gated `set_dormancy_grace(admin, seconds)` and read-only
    `get_dormancy_grace()` configure a global grace period (`0` = disabled) and
    emit `("stream", "dorm_grc")`.
  - Sender-only `sweep_dormant_stream(stream_id)` reclaims unclaimed vested
    funds after `now >= max(end_time, last_withdraw_time) + grace` for ended
    streams with positive withdrawable balance, applies protocol fee handling
    consistent with `withdraw`, marks the stream `Settled`, and emits
    `("stream", "dorm_swp")`.
  - Appended error codes `NotDormant = 24` and `DormancyDisabled = 25`.
  or sender can cancel before acceptance. Appended `Error::NoPendingTransfer = 24`
- **Stepped milestone release schedules (`ReleaseCurve`).** Streams now carry a
  `curve: ReleaseCurve` field (`Linear` by default, or `Milestones(Vec<Milestone>)`).
  The new `create_stream_with_milestones` entrypoint creates a milestone stream
  with `1..=32` strictly increasing timestamps in `[start_time, end_time]` and
  non-decreasing `cumulative_bps` ending at `10_000` (invalid schedules return
  `Error::InvalidSchedule = 24`). `release::vested_amount` uses the same
  pause-aware effective-time computation for milestones, `amend_stream` rejects
  milestone streams with `Error::InvalidState`, and `migrate` advances storage
  to version `3` to backfill `curve: ReleaseCurve::Linear` on legacy v2 records.
- **Recipient reject of draft streams.** `reject_stream(stream_id)` lets a
  stream's recipient decline a `Draft` stream created for them. It requires
  recipient authorisation, honours the contract-wide pause flag, and returns
  `InvalidState` for any stream that is not a draft (including a second reject).
  The full escrow is refunded to the sender, the stream becomes `Cancelled`, the
  sender's stream count is decremented as in `cancel_stream`, and a
  `("stream", "rejected")` event (`stream_id`, `recipient`, `returned_amount`,
  `timestamp`) is emitted after the transfer.
- **Split stream pause/resume.** `pause_split_stream` and
  `resume_split_stream` let a split stream's sender freeze and restart
  accrual for every recipient. Pausing records `pause_time`; resuming adds the
  paused span to `total_paused_duration`, extends `end_time` by the same span,
  and emits `split_pa` / `split_re` events. Both require sender authorisation,
  honour the contract-wide pause flag, and reject invalid transitions with
  `InvalidState`.

### Changed
- **Protocol fee on `withdraw_split` (#1966).** `SplitStream` now snapshots
  `default_fee_bps` into a new `fee_bps` field at creation time (validated by
  `fees::validate_fee_bps`). Each `withdraw_split` call applies floor-rounded
  protocol fees (`fee = floor(amount * fee_bps / 10_000)`, `net = amount - fee`),
  transfers `net` to the recipient and `fee` to the configured fee collector
  (forwarding `fee` to the recipient when no collector is set), accrues the fee
  via `fees::accrue_fees`, and emits `("stream", "fee")` when `fee > 0` and a
  collector is configured. Gross-amount release and settlement bookkeeping are
  unchanged, `sweep_fees` now also resolves split-stream tokens, and
  `cancel_split_stream` remains fee-free for consistency with `cancel_stream`.
- **Storage layout v2 migration.** `migrate` now advances contracts to storage
  version 2, normalising pause bookkeeping on split and recurring records
  (`pause_time` / `paused_at` are cleared unless the record is `Paused`) and
  re-stamping their TTLs. Records are rewritten in batches of 50 ids per call;
  `storage_version()` stays at 1 until every record has been visited, and
  re-running `migrate` at the latest version remains a no-op. Existing records
  and balances are preserved.
- **Guarded withdraw fee parity.** `withdraw_with_max_fee_bps` now charges the
  stream's own `stream.fee_bps` (set at creation) and pays the configured
  fee collector, identically to `withdraw`. Previously it compared and
  charged the global `storage::get_fee_bps` value and paid the admin
  address, and it ignored the withdrawer allowlist. The guarded variant is
  now a thin wrapper over the same internal logic as `withdraw`:
  - checks `stream.fee_bps > max_fee_bps` and returns `FeeTooHigh` before
    any state change (error precedence: `FeeTooHigh` first, then pause,
    amount, auth and state, matching `withdraw`);
  - otherwise delegates to the same internal function as `withdraw`
    (allowlist auth, state checks, accrual, payout helper with collector
    routing, and events).
- **ABI breaking change.** `withdraw_with_max_fee_bps` has gained a leading
  `caller: Address` parameter to align with `withdraw`:
  `withdraw_with_max_fee_bps(caller, stream_id, amount, max_fee_bps)`.
  This is changed in place (rather than kept as a deprecated wrapper)
  because the old signature cannot honour the allowlist for a non-recipient
  withdrawer without an explicit caller, and keeping it would preserve the
  very fee-routing bug this change fixes. Callers must pass the withdrawer
  address as the first argument. See the fee-routing table below.
  - Global `storage::get_fee_bps` / `set_fee_bps` is no longer charged at
  withdrawal time. It is the default for newly created streams and is
  documented as such on `set_fee_bps` and in the README fee table.
  `set_default_fee_bps` is the canonical admin knob for this default;
  `set_fee_bps` is retained as a backward-compatible alias and must not be
  read by any withdrawal path.

### Fee routing (before → after)

| Aspect | Before (buggy) | After |
| --- | --- | --- |
| Fee rate used by `withdraw` | `stream.fee_bps` | `stream.fee_bps` |
| Fee rate used by `withdraw_with_max_fee_bps` | global `storage::get_fee_bps` | `stream.fee_bps` |
| Fee recipient (`withdraw`) | fee collector | fee collector |
| Fee recipient (`withdraw_with_max_fee_bps`) | admin | fee collector |
| Allowlist enforced (`withdraw`) | yes | yes |
| Allowlist enforced (`withdraw_with_max_fee_bps`) | no | yes |
| `fee_charged` event payee | admin | fee collector |

### Added
- **Snapshot diff** (GrantFox FWC26). Two new read-only entrypoints for
  computing point-in-time financial state and the delta between two observations:
  - `stream_snapshot(stream_id, at_timestamp)` — captures `vested_amount`,
    `released_amount`, `locked_amount`, `withdrawable_amount`, and `status`
    at any caller-supplied ledger timestamp. Returns a `StreamSnapshot`.
  - `diff_snapshots(before, after)` — computes the field-by-field delta
    (`delta_vested`, `delta_released`, `delta_locked`, `delta_withdrawable`,
    `elapsed_seconds`, `status_before`, `status_after`) between two snapshots.
    Returns a `SnapshotDiff`.

  Both entrypoints are purely read-only, require no auth, and are unaffected
  by the global pause flag. Cross-stream diffs (mismatched `stream_id`) return
  `Error::NotFound`. Reversed-order timestamps are accepted; `elapsed_seconds`
  is always the absolute difference between the two timestamps.

  New public types exported from the crate root:
  - `StreamSnapshot` — `stream_id`, `timestamp`, `vested_amount`,
    `released_amount`, `locked_amount`, `withdrawable_amount`, `status`.
  - `SnapshotDiff` — `stream_id`, `from_timestamp`, `to_timestamp`,
    `delta_vested`, `delta_released`, `delta_locked`, `delta_withdrawable`,
    `elapsed_seconds`, `status_before`, `status_after`.

  Sixteen focused unit tests in `snapshot_diff.rs` covering: Draft/Active/
  Paused/Settled/Cancelled streams, partial releases, paused-duration
  exclusion, at/before start time, large amounts (near `ii28_max/4`),
  zero timestamps, reversed-order diffs, mismatched stream IDs, status
  transitions, and zero-delta same-snapshot diffs.

- `get_admin_nonce()` — read-only query for the next expected nonce value
  (admin nonce / replay prevention, `#949`).
- `admin_override(admin, nonce, stream_id, new_end_time) → Stream`
  — privileged override of a stream's `end_time`, guarded by a
  monotonic nonce that prevents replay attacks.
- New error codes: `NonceTooLow = 14`, `NonceOutOfOrder = 15`.
- New error code: `RecipientTrustlineMissing = 16` (was already
  referenced in `lib.rs`; now formally declared in `error.rs`).
- New module `src/admin.rs` containing the nonce storage key,
  `consume_nonce`, and the `admin_override` module implementation.
- New test module `src/admin_nonce_test.rs` with 14 focused tests
  covering replay prevention, out-of-order nonces, auth failures,
  terminal-state guards, and time-range validation.
  See `contracts/ADMIN_NONCE.md` for design rationale and usage.
- **Paginated stream enumeration views** (GrantFox FWC26). Six read-only
  entrypoints for off-chain consumers (indexers, frontends, analytics):
  - `list_streams(start_after, limit)` — all streams, ordered by ID.
  - `list_streams_by_sender(sender, start_after, limit)` — filtered by sender.
  - `list_streams_by_recipient(recipient, start_after, limit)` — filtered by recipient.
  - `list_streams_by_status(status, start_after, limit)` — filtered by status.
  - `list_streams_recipient_status(recipient, status, start_after, limit)` — compound filter.
  - `list_streams_sender_status(sender, status, start_after, limit)` — compound filter.

  All views share a cursor-based pagination API (`StreamPage { streams, next_cursor }`).
  The `limit` parameter is capped at `MAX_PAGE_SIZE = 100`. Views require no auth
  and are unaffected by the global pause flag.

- `storage::peek_next_stream_id` — side-effect-free read of the stream-ID counter
  used by all view functions as the exclusive upper-bound for paginated scans.

- Overflow-safe arithmetic: all pagination boundaries use `saturating_add` /
  `saturating_sub`; `start_after = u64::MAX` and `limit = 0` are handled cleanly.

- Focused unit tests in `views.rs` covering:
  normal pagination, multi-page cursor chaining, filtered views, gap handling,
  `u64::MAX` overflow safety, `limit = 0`, `start_after = Some(0)` identity,
  and no-match cases for all filter combinations.

- Integration tests in `views_integration_test.rs` covering all six view
  entrypoints via the `ContractClient` interface with real on-chain state.

- Module-level documentation for `error.rs`, `storage.rs`, and events
  schema in `events.rs`.
- `init_with_token_allowlist(admin, tokens)` entrypoint. Performs the
  work of `initialize` and then marks every address in `tokens` as
  `allowed = true` in a single transaction, replacing the
  previously-required `initialize` + N `set_token_allowed` two-step
  deploy flow. Old `initialize` path is unchanged for backward
  compatibility.

### Notes
- TTL tuning for stream and instance keys remains at the same constants
  the operational runbook assumes.

## [0.1.0] - Initial draft

### Added
- `initialize`, `create_stream`, `start_stream`, `withdraw`, `pause`,
  `resume`, `settle` entry points.
- Per-token allowlist via `set_token_allowed`.
- Global emergency pause via `set_paused`.
- `created`, `started`, `withdrawn`, `settled`, `paused`, `resumed`
  events.
