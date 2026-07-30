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
  exclusion, at/before start time, large amounts (near `i128::MAX/4`),
  zero timestamps, reversed-order diffs, mismatched stream IDs, status
  transitions, and zero-delta same-snapshot diffs.

- **Admin nonce / replay prevention** (`#949`).
  - New entrypoint `get_admin_nonce() → u64` — read-only query for the
    next expected nonce value.
  - New entrypoint `admin_override(admin, nonce, stream_id, new_end_time) → Stream`
    — privileged override of a stream's `end_time`, guarded by a
    monotonic nonce that prevents replay attacks.
  - New error codes: `NonceTooLow = 14`, `NonceOutOfOrder = 15`.
  - New error code: `RecipientTrustlineMissing = 16` (was already
    referenced in `lib.rs`; now formally declared in `error.rs`).
  - New module `src/admin.rs` containing the nonce storage key,
    `consume_nonce`, and the `admin_override` implementation.
  - New test module `src/admin_nonce_test.rs` with 14 focused tests
    covering replay prevention, out-of-order nonces, auth failures,
    terminal-state guards, and time-range validation.
  - See `contracts/ADMIN_NONCE.md` for design rationale and usage.
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
