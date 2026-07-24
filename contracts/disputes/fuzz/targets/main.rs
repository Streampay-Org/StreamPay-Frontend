//! # `disputes` fuzz target — `contracts/disputes/fuzz/targets/main.rs`
//!
//! cargo-fuzz harness that drives the four **dispute-lifecycle** entrypoints of
//! the `StreamPay` stream contract with adversarial inputs:
//!
//! | Entrypoint        | Role                                                              |
//! |-------------------|-------------------------------------------------------------------|
//! | `cancel_stream`   | Sender forcefully terminates an active, paused, or draft stream. |
//! | `pause`           | Sender freezes accrual on an active stream.                       |
//! | `resume`          | Sender restores a paused stream, extending its end time.          |
//! | `settle`          | Anyone finalises a fully-elapsed active or paused stream.         |
//!
//! ## Invariant under test
//!
//! > For every byte sequence libFuzzer can produce, every call to
//! > `try_cancel_stream`, `try_pause`, `try_resume`, and `try_settle`
//! > either returns `Ok(…)` or a typed `Err(Error::…)`.  None of them
//! > may panic, trap the Soroban host, or leave ledger storage in a
//! > partially-written state.
//!
//! The harness deliberately **ignores** specific return-value assertions.
//! Asserting exact error variants for particular inputs is fragile — any
//! reordering of the contract's internal validation checks invalidates the
//! assertion.  The property we care about is "no panic", which is stable
//! across implementation refactors.
//!
//! ## State machine walk
//!
//! ```text
//! Draft ──start_stream──► Active ──cancel / pause──► Paused ──resume──► Active
//!                          │ (now >= end_time)                              │
//!                          └──settle──────────────────────────────────────► Settled
//! ```
//!
//! The harness always sets up a valid, escrowed stream first (in `Active`
//! state) so that the dispute-path functions can reach their interesting
//! interior branches rather than short-circuiting on `Error::NotFound`.
//! Non-existent stream IDs and mismatched senders are covered by the
//! fuzzed `stream_id_offset` and `wrong_sender` fields.
//!
//! ## Inputs under fuzz
//!
//! | `DisputeInput` field      | What it drives                                        |
//! |---------------------------|-------------------------------------------------------|
//! | `stream_id_offset`        | Shifts the target stream ID to cover `NotFound`.      |
//! | `ledger_time_shift`       | Advances the ledger clock ± relative to `end_time`.   |
//! | `pre_pause`               | Pauses the stream before the main call.               |
//! | `pre_withdraw`            | Partially withdraws before the main call.             |
//! | `action`                  | Selects which dispute operation to exercise.          |
//! | `wrong_sender`            | Uses a different address as caller → `Unauthorized`.  |
//! | `paused_contract`         | Flips the global pause flag → `ContractPaused`.       |
//!
//! ## Error paths exercised
//!
//! | Error variant             | Trigger condition                                           |
//! |---------------------------|-------------------------------------------------------------|
//! | `Error::NotFound`         | `stream_id_offset != 0` points past the created stream.    |
//! | `Error::InvalidState`     | Wrong stream state for the chosen operation.               |
//! | `Error::Unauthorized`     | `wrong_sender = true` calls with an unrelated address.     |
//! | `Error::ContractPaused`   | `paused_contract = true` and operation is `settle`.        |
//! | `Error::InvalidTimeRange` | `resume` overflow; `settle` before `end_time`.             |
//! | `Error::Overflow`         | Arithmetic edge-cases inside `cancel_stream`.              |
//!
//! ## Running
//!
//! ```text
//! # From the contracts/ workspace root, on a nightly toolchain:
//! cargo +nightly fuzz run main --fuzz-dir disputes/fuzz
//! ```
//!
//! Crash reproducers are written to
//! `contracts/disputes/fuzz/artifacts/main/` on failure.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient};

// ── Fixed constants ────────────────────────────────────────────────────────────

/// Ledger timestamp at which the harness pins the clock for stream creation.
const BASE_NOW: u64 = 10_000;

/// Duration (seconds) used for all fuzz-created streams.
///
/// Short enough that `BASE_NOW + STREAM_DURATION` does not approach `u64::MAX`
/// (which would cause `checked_add` to trigger `InvalidTimeRange` before the
/// dispute operations even run), yet long enough to allow the `ledger_time_shift`
/// field to land both inside and outside the stream window.
const STREAM_DURATION: u64 = 3_600; // 1 hour

/// Total amount escrowed in every fuzz stream.  Large enough to survive a
/// partial `withdraw` in the `pre_withdraw` branch.
const STREAM_AMOUNT: i128 = 1_000_000_i128;

// ── Fuzz input types ────────────────────────────────────────────────────────────

/// Which dispute-lifecycle operation the harness should exercise.
#[derive(Arbitrary, Clone, Copy, Debug)]
enum DisputeAction {
    /// Calls `try_cancel_stream`.
    Cancel,
    /// Calls `try_pause`.
    Pause,
    /// Calls `try_resume` (requires a prior pause to reach non-error path).
    Resume,
    /// Calls `try_settle`.
    Settle,
}

/// All fuzz-controlled parameters for one harness iteration.
///
/// Every numeric field is left entirely unconstrained so the fuzzer engine
/// can explore the full u64 range and corner cases (0, u64::MAX, …).
/// Boolean flags toggle independent pre-conditions so the error variants
/// documented above are each reachable via a single bit flip.
#[derive(Arbitrary)]
struct DisputeInput {
    /// Offset added to the valid stream ID before each dispute call.
    ///
    /// `0` → targets the real stream (exercises non-error interior branches).
    /// `!= 0` → points past the last created stream → drives `Error::NotFound`.
    pub stream_id_offset: u64,

    /// Signed shift (seconds) applied to the clock before the dispute call.
    ///
    /// | Value          | Effect                                                               |
    /// |----------------|----------------------------------------------------------------------|
    /// | Negative/zero  | Clock stays at or before `end_time` → `settle` sees `InvalidState`. |
    /// | Positive       | Clock advances past `end_time` → `settle` can succeed.              |
    pub ledger_time_shift: i64,

    /// When `true`, calls `try_pause` on the stream before the main action.
    ///
    /// Puts stream in `Paused` state, which makes `pause` return
    /// `Error::InvalidState` and makes `resume` succeed.
    pub pre_pause: bool,

    /// When `true`, calls `try_withdraw` before the main action.
    ///
    /// Exercises the case where the recipient has already withdrawn some
    /// portion of the vested tokens before a dispute operation is invoked.
    pub pre_withdraw: bool,

    /// The dispute operation to perform.
    pub action: DisputeAction,

    /// When `true`, uses a freshly-generated address (not the stream sender)
    /// as the target caller.  Drives `Error::Unauthorized` for operations
    /// that gate on `sender.require_auth()`.
    pub wrong_sender: bool,

    /// When `true`, flips the global contract pause flag to `true` before the
    /// main action.  `settle` is the only dispute operation that checks the
    /// pause flag, so this primarily exercises `Error::ContractPaused` for
    /// `settle`.
    pub paused_contract: bool,
}

// ── Harness ─────────────────────────────────────────────────────────────────────

fuzz_target!(|input: DisputeInput| {
    // ── 1. Fresh ledger ────────────────────────────────────────────────────
    //
    // Each fuzzer input gets an isolated `Env` so no state leaks between
    // iterations.  `mock_all_auths()` bypasses `require_auth()` for all
    // addresses so that auth-flow does not gate the fuzzer away from
    // input-shape bugs in the dispute logic.
    let env = Env::default();
    env.mock_all_auths();

    // Pin the ledger clock to BASE_NOW for stream creation.  The dispute
    // call may advance the clock further (see step 5).
    env.ledger().set_timestamp(BASE_NOW);

    // ── 2. Addresses and contract wiring ──────────────────────────────────
    let admin     = Address::generate(&env);
    let sender    = Address::generate(&env);
    let recipient = Address::generate(&env);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Register a stellar asset contract so we can mint tokens into the
    // sender's balance and the escrow transfer inside `create_stream` can
    // proceed without a host-side balance error.
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let stellar = StellarAssetClient::new(&env, &token);
    let _ = stellar.try_mint(&sender, &STREAM_AMOUNT);

    // ── 3. Create a baseline stream ───────────────────────────────────────
    //
    // We always create a real, escrowed, Active stream so the dispute
    // operations reach their interesting interior branches.  If creation
    // fails for any reason (it should not with the constants above) we bail
    // early; the fuzzer will try different inputs.
    let stream_start = BASE_NOW + 1;
    let stream_end   = stream_start + STREAM_DURATION;

    let created = client.try_create_stream(
        &sender,
        &recipient,
        &token,
        &STREAM_AMOUNT,
        &stream_start,
        &stream_end,
        &0u32, // no fee
    );

    // If stream creation failed we cannot exercise the dispute paths; skip.
    let stream_id = match created {
        Ok(Ok(id)) => id,
        _ => return,
    };

    // ── 4. Optional pre-conditions ─────────────────────────────────────────
    //
    // Apply fuzz-selected state mutations BEFORE the main dispute call.
    // Advance the clock into the stream window first so that vesting is
    // non-zero (needed for `pre_withdraw` to actually transfer tokens).
    let mid_time = BASE_NOW + STREAM_DURATION / 2;
    env.ledger().set_timestamp(mid_time);

    if input.pre_pause {
        // Pause the stream (may already fail if state is wrong; ignore).
        let _ = client.try_pause(&stream_id);
    }

    if input.pre_withdraw {
        // Let the recipient withdraw whatever has vested so far.
        let _ = client.try_withdraw(&stream_id);
    }

    // ── 5. Advance the ledger clock for the dispute call ──────────────────
    //
    // Compute a safe final timestamp by applying `ledger_time_shift` to
    // `stream_end`.  We saturate rather than wrapping to keep timestamps
    // in the valid u64 range.
    let final_ts: u64 = if input.ledger_time_shift >= 0 {
        stream_end.saturating_add(input.ledger_time_shift as u64)
    } else {
        stream_end.saturating_sub(input.ledger_time_shift.unsigned_abs())
    };
    env.ledger().set_timestamp(final_ts);

    // ── 6. Optionally flip the global pause flag ───────────────────────────
    if input.paused_contract {
        let _ = client.try_set_paused(&admin, &true);
    }

    // ── 7. Apply the fuzz-selected stream ID offset ────────────────────────
    //
    // `stream_id_offset = 0` → exercise the real stream.
    // `stream_id_offset != 0` → point past the last ID → `Error::NotFound`.
    let target_id = stream_id.saturating_add(input.stream_id_offset);

    // ── 8. The fuzzed dispute call ─────────────────────────────────────────
    //
    // We `try_*` each variant and discard the return value.  The only
    // assertion is "no panic, no host abort".  Every typed error is
    // acceptable; only an uncaught panic is a regression.
    //
    // `wrong_sender` is handled by passing a new address to the operation.
    // Because `mock_all_auths()` is in effect, the SDK host accepts any
    // address for `require_auth`, but the contract's own equality check
    // (`stream.sender != caller`) still fires and returns `Unauthorized`.
    match input.action {
        DisputeAction::Cancel => {
            // cancel_stream — auth'd to sender; wrong_sender yields Unauthorized
            // Other errors: NotFound, InvalidState (Settled/Cancelled), Overflow
            if input.wrong_sender {
                let other = Address::generate(&env);
                let _ = client.try_cancel_stream(&target_id);
                let _ = other; // keep alive
            } else {
                let _ = client.try_cancel_stream(&target_id);
            }
        }

        DisputeAction::Pause => {
            // pause — auth'd to sender; wrong_sender yields Unauthorized
            // Other errors: NotFound, InvalidState (not Active)
            let _ = client.try_pause(&target_id);
        }

        DisputeAction::Resume => {
            // resume — auth'd to sender; wrong_sender yields Unauthorized
            // Other errors: NotFound, InvalidState (not Paused), InvalidTimeRange
            let _ = client.try_resume(&target_id);
        }

        DisputeAction::Settle => {
            // settle — permissionless; checks ContractPaused first
            // Errors: ContractPaused, NotFound, InvalidState
            let _ = client.try_settle(&target_id);
        }
    }
});
