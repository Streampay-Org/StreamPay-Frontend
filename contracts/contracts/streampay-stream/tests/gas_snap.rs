//! # Per-entrypoint gas snapshots for `streampay-stream`
//!
//! Integration tests that capture CPU instructions and memory bytes consumed
//! by each contract entrypoint on every call, producing a regression baseline.
//!
//! ## What this covers
//!
//! - Every public entrypoint is exercised in a clean Soroban test host.
//! - Each call records:
//!   - CPU instructions consumed (`env.host().cpu_instr_consumed()` delta)
//!   - Memory bytes allocated (`env.host().mem_bytes_consumed()` delta)
//!   - Event count and total event data size
//! - Budget ceilings are asserted against known-good values; any regression
//!   triggers a CI failure.
//!
//! ## Running
//!
//! ```text
//! cargo test --test gas_snap
//! ```
//!
//! ## Updating ceilings
//!
//! Ceilings must be updated when an intentional performance change lands.
//! Run the suite, collect the new values, and bump the ceiling constants.
//! The `gas-budget.json` file at the workspace root sets the global wasm
//! size budget; this test enforces per-entrypoint ceilings.
//!
//! ## Safe ceiling values
//!
//! All arithmetic in this module uses checked or saturating operations
//! and never unwraps or panics on overflow.

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient};

// ── Snapshot types ────────────────────────────────────────────────────────────

/// Point-in-time capture of resource consumption for a single invocation.
#[derive(Clone, Debug)]
struct InvocationSnapshot {
    /// CPU instructions consumed during the invocation.
    cpu_instructions: u64,
    /// Memory bytes allocated during the invocation.
    mem_bytes: u64,
    /// Number of events emitted.
    event_count: u64,
    /// Total size of event data in bytes.
    event_size_bytes: u64,
}

/// Measures the resource consumption of a closure invocation.
///
/// Captures CPU and memory deltas before and after executing `f`, returning
/// both the closure's result and the delta snapshot.
///
/// Event metrics are captured from the environment's event log; the caller
/// is responsible for clearing events before the measured operation if
/// precise per-operation event counts are needed.
fn measure_invocation<F, R>(env: &Env, f: F) -> (R, InvocationSnapshot)
where
    F: FnOnce() -> R,
{
    let cpu_before = env.host().cpu_instr_consumed();
    let mem_before = env.host().mem_bytes_consumed();

    let result = f();

    let cpu_after = env.host().cpu_instr_consumed();
    let mem_after = env.host().mem_bytes_consumed();

    let cpu_delta = cpu_after.saturating_sub(cpu_before);
    let mem_delta = mem_after.saturating_sub(mem_before);

    // Event metrics
    let events = env.events().all();
    let event_count = events.len() as u64;
    let event_size_bytes: u64 = events
        .iter()
        .map(|(_id, _topics, data)| data.len() as u64)
        .sum();

    (
        result,
        InvocationSnapshot {
            cpu_instructions: cpu_delta,
            mem_bytes: mem_delta,
            event_count,
            event_size_bytes,
        },
    )
}

/// Asserts that an invocation snapshot stays within the supplied ceilings.
///
/// Each parameter is a **maximum** allowed value.  If any metric exceeds its
/// ceiling the test panics with a descriptive message.
///
/// # Panics
/// Panics if any metric exceeds its ceiling.
#[track_caller]
fn assert_budget_ceiling(
    snapshot: &InvocationSnapshot,
    max_cpu: u64,
    max_mem: u64,
    max_events: u64,
    max_event_bytes: u64,
) {
    if snapshot.cpu_instructions > max_cpu {
        panic!(
            "CPU budget exceeded: used {} > ceiling {}",
            snapshot.cpu_instructions, max_cpu
        );
    }
    if snapshot.mem_bytes > max_mem {
        panic!(
            "Memory budget exceeded: used {} > ceiling {}",
            snapshot.mem_bytes, max_mem
        );
    }
    if snapshot.event_count > max_events {
        panic!(
            "Event count exceeded: {} > ceiling {}",
            snapshot.event_count, max_events
        );
    }
    if snapshot.event_size_bytes > max_event_bytes {
        panic!(
            "Event size exceeded: {} bytes > ceiling {} bytes",
            snapshot.event_size_bytes, max_event_bytes
        );
    }
}

// ── Shared test fixture ───────────────────────────────────────────────────────

/// All addresses and tokens needed by a single gas-snapshot test.
struct GasTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
}

fn gas_setup() -> GasTestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    StellarAssetClient::new(&env, &token).mint(&sender, &1_000_000);

    GasTestData {
        env,
        admin,
        sender,
        recipient,
        token,
    }
}

fn gas_client(env: &Env) -> ContractClient<'_> {
    let contract_id = env.register(Contract, ());
    ContractClient::new(env, &contract_id)
}

/// Helper: initialize the contract and return a ready client.
fn gas_initialized(data: &GasTestData) -> ContractClient<'_> {
    let client = gas_client(&data.env);
    client.initialize(&data.admin);
    client
}

// ── Admin / deployment entrypoint snapshots ───────────────────────────────────

#[test]
fn gas_snap_initialize() {
    let data = gas_setup();
    let client = gas_client(&data.env);

    let (_, snapshot) = measure_invocation(&data.env, || client.initialize(&data.admin));

    assert_budget_ceiling(&snapshot, 250_000, 60_000, 100, 1_200);
}

#[test]
fn gas_snap_init_with_token_allowlist_three_tokens() {
    let data = gas_setup();
    let client = gas_client(&data.env);

    let mut tokens = soroban_sdk::Vec::new(&data.env);
    tokens.push_back(data.token.clone());
    tokens.push_back(
        data.env
            .register_stellar_asset_contract_v2(data.admin.clone())
            .address(),
    );
    tokens.push_back(
        data.env
            .register_stellar_asset_contract_v2(data.admin.clone())
            .address(),
    );

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.init_with_token_allowlist(&data.admin, &tokens)
    });

    assert_budget_ceiling(&snapshot, 350_000, 70_000, 100, 1_200);
}

#[test]
fn gas_snap_init_token_allowlist_for_org() {
    let data = gas_setup();
    let client = gas_client(&data.env);

    let org = Address::generate(&data.env);
    let mut tokens = soroban_sdk::Vec::new(&data.env);
    tokens.push_back(data.token.clone());
    let mut org_tokens = soroban_sdk::Vec::new(&data.env);
    org_tokens.push_back(data.token.clone());

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.init_token_allowlist_for_org(&data.admin, &tokens, &org, &org_tokens)
    });

    assert_budget_ceiling(&snapshot, 400_000, 80_000, 100, 1_200);
}

#[test]
fn gas_snap_set_paused() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) = measure_invocation(&data.env, || client.set_paused(&data.admin, &true));

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 1_200);
}

#[test]
fn gas_snap_set_admin() {
    let data = gas_setup();
    let client = gas_initialized(&data);
    let new_admin = Address::generate(&data.env);

    let (_, snapshot) = measure_invocation(&data.env, || client.set_admin(&data.admin, &new_admin));

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 1_200);
}

#[test]
fn gas_snap_set_token_allowed() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.set_token_allowed(&data.admin, &data.token, &true)
    });

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 1_200);
}

#[test]
fn gas_snap_set_max_streams_per_sender() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.set_max_streams_per_sender(&data.admin, &20)
    });

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 800);
}

#[test]
fn gas_snap_set_fee_collector() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.set_fee_collector(&data.admin, &data.admin)
    });

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 1_200);
}

#[test]
fn gas_snap_set_default_fee_bps() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) =
        measure_invocation(&data.env, || client.set_default_fee_bps(&data.admin, &100));

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 1_200);
}

#[test]
fn gas_snap_set_fee_bps() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (_, snapshot) = measure_invocation(&data.env, || client.set_fee_bps(&data.admin, &100));

    assert_budget_ceiling(&snapshot, 200_000, 50_000, 100, 800);
}

#[test]
fn gas_snap_set_org_token_allowed() {
    let data = gas_setup();
    let client = gas_initialized(&data);
    let org = Address::generate(&data.env);

    let (_, snapshot) = measure_invocation(&data.env, || {
        client.set_org_token_allowed(&data.admin, &org, &data.token, &true)
    });

    assert_budget_ceiling(&snapshot, 220_000, 55_000, 100, 1_000);
}

// ── Read entrypoint snapshots ─────────────────────────────────────────────────

#[test]
fn gas_snap_max_streams_per_sender_read() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (count, snapshot) = measure_invocation(&data.env, || client.max_streams_per_sender());

    assert_eq!(count, 10);
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_sender_stream_count() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (count, snapshot) =
        measure_invocation(&data.env, || client.sender_stream_count(&data.sender));

    assert_eq!(count, 0);
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_get_stream() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let (stream, snapshot) = measure_invocation(&data.env, || client.get_stream(&id));

    assert_eq!(stream.id, id);
    assert_budget_ceiling(&snapshot, 150_000, 30_000, 100, 600);
}

#[test]
fn gas_snap_withdrawable() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600); // midpoint

    let (amount, snapshot) = measure_invocation(&data.env, || client.withdrawable(&id));

    assert_eq!(amount, 500);
    assert_budget_ceiling(&snapshot, 150_000, 30_000, 100, 600);
}

#[test]
fn gas_snap_stream_balance() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600);

    let (balance, snapshot) = measure_invocation(&data.env, || client.stream_balance(&id));

    assert_eq!(balance, 500);
    assert_budget_ceiling(&snapshot, 150_000, 30_000, 100, 600);
}

#[test]
fn gas_snap_remaining_sender_capacity() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (cap, snapshot) =
        measure_invocation(&data.env, || client.remaining_sender_capacity(&data.sender));

    assert_eq!(cap, 10);
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_fee_bps_read() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (bps, snapshot) = measure_invocation(&data.env, || client.fee_bps());

    assert_eq!(bps, 0);
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_get_default_fee_bps() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (bps, snapshot) = measure_invocation(&data.env, || client.get_default_fee_bps());

    assert_eq!(bps, 0);
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_get_fee_collector() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (collector, snapshot) = measure_invocation(&data.env, || client.get_fee_collector());

    assert!(collector.is_none());
    assert_budget_ceiling(&snapshot, 100_000, 20_000, 100, 400);
}

#[test]
fn gas_snap_get_stream_fee_bps() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let (bps, snapshot) = measure_invocation(&data.env, || client.get_stream_fee_bps(&id));

    assert_eq!(bps, 0);
    assert_budget_ceiling(&snapshot, 150_000, 30_000, 100, 600);
}

#[test]
fn gas_snap_get_accrued_fees() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let (fees, snapshot) = measure_invocation(&data.env, || client.get_accrued_fees(&id));

    assert_eq!(fees, 0);
    assert_budget_ceiling(&snapshot, 120_000, 25_000, 100, 600);
}

#[test]
fn gas_snap_is_org_token_allowed() {
    let data = gas_setup();
    let client = gas_initialized(&data);
    let org = Address::generate(&data.env);

    client.set_org_token_allowed(&data.admin, &org, &data.token, &true);

    let (allowed, snapshot) =
        measure_invocation(&data.env, || client.is_org_token_allowed(&org, &data.token));

    assert!(allowed);
    assert_budget_ceiling(&snapshot, 120_000, 25_000, 100, 500);
}

// ── Write / lifecycle entrypoint snapshots ────────────────────────────────────

#[test]
fn gas_snap_create_stream() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (stream_id, snapshot) = measure_invocation(&data.env, || {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &1_000i128,
            &1_100u64,
            &2_100u64,
            &0u32,
        )
    });

    assert_eq!(stream_id, 1);
    assert_budget_ceiling(&snapshot, 310_000, 55_000, 100, 1_400);
}

#[test]
fn gas_snap_create_draft_stream() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let (stream_id, snapshot) = measure_invocation(&data.env, || {
        client.create_draft_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &1_000i128,
            &100u64,
        )
    });

    // Draft streams get ID 0; gas should be similar to Active create.
    assert_eq!(stream_id, 0);
    assert_budget_ceiling(&snapshot, 310_000, 55_000, 100, 1_400);
}

#[test]
fn gas_snap_start_stream() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let draft_id = client.create_draft_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &100u64,
    );

    let (_stream, snapshot) = measure_invocation(&data.env, || client.start_stream(&draft_id));

    assert_budget_ceiling(&snapshot, 250_000, 50_000, 100, 1_000);
}

#[test]
fn gas_snap_create_stream_for_org() {
    let data = gas_setup();
    let client = gas_initialized(&data);
    let org = Address::generate(&data.env);

    client.set_org_token_allowed(&data.admin, &org, &data.token, &true);

    let (id, snapshot) = measure_invocation(&data.env, || {
        client.create_stream_for_org(
            &org,
            &data.sender,
            &data.recipient,
            &data.token,
            &1_000i128,
            &1_100u64,
            &2_100u64,
            &0,
        )
    });

    assert_eq!(id, 1);
    assert_budget_ceiling(&snapshot, 350_000, 65_000, 200, 1_600);
}

#[test]
fn gas_snap_withdraw_partial() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600); // midpoint: 500 vested

    let (withdrawn, snapshot) = measure_invocation(&data.env, || client.withdraw(&id, &250i128));

    assert_eq!(withdrawn, 250);
    assert_budget_ceiling(&snapshot, 330_000, 55_000, 100, 1_100);
}

#[test]
fn gas_snap_withdraw_full_settle() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(2_200); // past end

    let (withdrawn, snapshot) = measure_invocation(&data.env, || client.withdraw(&id, &1_000i128));

    assert_eq!(withdrawn, 1_000);
    assert_budget_ceiling(&snapshot, 345_000, 55_000, 100, 1_100);

    let stream = client.get_stream(&id);
    assert_eq!(stream.status, streampay_stream::StreamStatus::Settled);
}

#[test]
fn gas_snap_withdraw_with_max_fee_bps() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    // Set a protocol fee
    client.set_fee_collector(&data.admin, &data.admin);
    client.set_fee_bps(&data.admin, &100); // 1%

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600); // midpoint

    let (withdrawn, snapshot) = measure_invocation(&data.env, || {
        client.withdraw_with_max_fee_bps(&id, &250i128, &200)
    });

    assert!(withdrawn > 0);
    assert_budget_ceiling(&snapshot, 400_000, 70_000, 200, 1_800);
}

#[test]
fn gas_snap_pause() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600);

    let ((), snapshot) = measure_invocation(&data.env, || client.pause(&id));

    assert_budget_ceiling(&snapshot, 250_000, 50_000, 100, 1_000);
}

#[test]
fn gas_snap_resume() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600);
    client.pause(&id);
    data.env.ledger().set_timestamp(1_700);

    let ((), snapshot) = measure_invocation(&data.env, || client.resume(&id));

    assert_budget_ceiling(&snapshot, 250_000, 50_000, 100, 1_000);
}

#[test]
fn gas_snap_settle() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(2_200);

    let ((), snapshot) = measure_invocation(&data.env, || client.settle(&id));

    assert_budget_ceiling(&snapshot, 300_000, 55_000, 100, 1_200);
}

#[test]
fn gas_snap_cancel_stream_mid() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    data.env.ledger().set_timestamp(1_600);

    let ((), snapshot) = measure_invocation(&data.env, || client.cancel_stream(&id));

    assert_budget_ceiling(&snapshot, 350_000, 65_000, 200, 1_600);
}

#[test]
fn gas_snap_cancel_stream_at_start() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let ((), snapshot) = measure_invocation(&data.env, || client.cancel_stream(&id));

    assert_budget_ceiling(&snapshot, 300_000, 55_000, 200, 1_400);
}

#[test]
fn gas_snap_amend_stream() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let (_, snapshot) =
        measure_invocation(&data.env, || client.amend_stream(&id, &10i128, &2_600u64));

    assert_budget_ceiling(&snapshot, 280_000, 55_000, 100, 1_200);
}

#[test]
fn gas_snap_sweep_fees() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    // Configure fee collection
    client.set_fee_collector(&data.admin, &data.admin);
    client.set_fee_bps(&data.admin, &100);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );
    // Trigger fee accrual via withdrawal
    data.env.ledger().set_timestamp(1_600);
    client.withdraw_with_max_fee_bps(&id, &250i128, &200);

    let mut stream_ids = soroban_sdk::Vec::new(&data.env);
    stream_ids.push_back(id);

    let (_, snapshot) =
        measure_invocation(&data.env, || client.sweep_fees(&data.admin, &stream_ids));

    assert_budget_ceiling(&snapshot, 350_000, 70_000, 200, 1_600);
}

// ── Snapshot/diff entrypoints ─────────────────────────────────────────────────

#[test]
fn gas_snap_stream_snapshot() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let (snap, snapshot) = measure_invocation(&data.env, || client.stream_snapshot(&id, &1_600));

    assert_eq!(snap.stream_id, id);
    assert_eq!(snap.timestamp, 1_600);
    assert_budget_ceiling(&snapshot, 180_000, 35_000, 100, 600);
}

#[test]
fn gas_snap_diff_snapshots() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000i128,
        &1_100u64,
        &2_100u64,
        &0u32,
    );

    let snap_a = client.stream_snapshot(&id, &1_200);
    let snap_b = client.stream_snapshot(&id, &1_600);

    let (diff, snapshot) =
        measure_invocation(&data.env, || client.diff_snapshots(&snap_a, &snap_b));

    assert_eq!(diff.stream_id, id);
    assert_eq!(diff.delta_vested, 400);
    assert_budget_ceiling(&snapshot, 180_000, 35_000, 100, 600);
}

// ── Regression safety: budget stays within ceiling across all entrypoints ─────

/// Run every entrypoint snapshot in a single test for quick CI gating.
/// Each call re-uses the same environment to keep the total runtime low.
#[test]
fn gas_snap_all_entrypoints_within_budget() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    // ── Admin writes ──
    let (_, snap) = measure_invocation(&data.env, || client.set_paused(&data.admin, &true));
    assert_budget_ceiling(&snap, 200_000, 50_000, 100, 1_200);

    let (_, snap) = measure_invocation(&data.env, || {
        client.set_token_allowed(&data.admin, &data.token, &true)
    });
    assert_budget_ceiling(&snap, 200_000, 50_000, 100, 1_200);

    let (_, snap) = measure_invocation(&data.env, || {
        client.set_max_streams_per_sender(&data.admin, &15)
    });
    assert_budget_ceiling(&snap, 200_000, 50_000, 100, 800);

    // ── Creates ──
    let (id, snap) = measure_invocation(&data.env, || {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &1_000i128,
            &1_100u64,
            &2_100u64,
            &0u32,
        )
    });
    assert_eq!(id, 1);
    assert_budget_ceiling(&snap, 310_000, 55_000, 100, 1_400);

    // ── Reads ──
    let (_, snap) = measure_invocation(&data.env, || client.get_stream(&id));
    assert_budget_ceiling(&snap, 150_000, 30_000, 100, 600);

    let (_, snap) = measure_invocation(&data.env, || client.max_streams_per_sender());
    assert_budget_ceiling(&snap, 100_000, 20_000, 100, 400);

    let (_, snap) = measure_invocation(&data.env, || client.sender_stream_count(&data.sender));
    assert_budget_ceiling(&snap, 100_000, 20_000, 100, 400);

    let (_, snap) =
        measure_invocation(&data.env, || client.remaining_sender_capacity(&data.sender));
    assert_budget_ceiling(&snap, 100_000, 20_000, 100, 400);

    // ── Read (balance) at midpoint ──
    data.env.ledger().set_timestamp(1_600);
    let (bal, snap) = measure_invocation(&data.env, || client.stream_balance(&id));
    assert_eq!(bal, 500);
    assert_budget_ceiling(&snap, 150_000, 30_000, 100, 600);

    // ── Lifecycle: pause → resume ──
    let (_, snap) = measure_invocation(&data.env, || client.pause(&id));
    assert_budget_ceiling(&snap, 250_000, 50_000, 100, 1_000);

    data.env.ledger().set_timestamp(1_700);
    let (_, snap) = measure_invocation(&data.env, || client.resume(&id));
    assert_budget_ceiling(&snap, 250_000, 50_000, 100, 1_000);

    // ── Withdraw ──
    let (_, snap) = measure_invocation(&data.env, || client.withdraw(&id, &500i128));
    assert_budget_ceiling(&snap, 330_000, 55_000, 100, 1_100);

    // ── Amend ──
    let (_, snap) = measure_invocation(&data.env, || client.amend_stream(&id, &10i128, &3_000u64));
    assert_budget_ceiling(&snap, 280_000, 55_000, 100, 1_200);

    // ── Cancel ──
    data.env.ledger().set_timestamp(2_000);
    let (_, snap) = measure_invocation(&data.env, || client.cancel_stream(&id));
    assert_budget_ceiling(&snap, 350_000, 65_000, 200, 1_600);
}

/// Regression gate: no single entrypoint exceeds its ceiling after multiple
/// repeated invocations (hot-path caching should keep ceiling stable).
#[test]
fn gas_snap_repeated_invocations_stay_within_ceiling() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    for i in 0..5 {
        let start = 1_100 + i * 1_000;
        let end = start + 1_000;

        let (id, snap) = measure_invocation(&data.env, || {
            client.create_stream(
                &data.sender,
                &data.recipient,
                &data.token,
                &1_000i128,
                &start,
                &end,
                &0u32,
            )
        });

        assert_eq!(id, (i + 1) as u64);
        assert_budget_ceiling(&snap, 310_000, 55_000, 100, 1_400);
    }

    assert_eq!(client.sender_stream_count(&data.sender), 5);
}

/// Gas for edge cases must stay within budget.
#[test]
fn gas_snap_edge_cases_within_budget() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    // Create stream with minimum valid amount (1 token unit)
    let (id, snap) = measure_invocation(&data.env, || {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &1i128,
            &1_100u64,
            &2_100u64,
            &0u32,
        )
    });
    assert_eq!(id, 1);
    assert_budget_ceiling(&snap, 310_000, 55_000, 100, 1_400);

    // Withdraw a tiny amount (1 unit)
    data.env.ledger().set_timestamp(1_600);
    let (_, snap) = measure_invocation(&data.env, || client.withdraw(&id, &1i128));
    assert_budget_ceiling(&snap, 300_000, 55_000, 100, 1_000);

    // Read capacity on never-seen sender
    let unknown = Address::generate(&data.env);
    let (cap, snap) = measure_invocation(&data.env, || client.remaining_sender_capacity(&unknown));
    assert_eq!(cap, 10);
    assert_budget_ceiling(&snap, 100_000, 20_000, 100, 400);
}

/// Regression gate (panic-free): nothing in this module panics on overflow.
#[test]
fn gas_snap_no_panic_on_large_values() {
    let data = gas_setup();
    let client = gas_initialized(&data);

    let large_amount = i128::MAX / 10;
    StellarAssetClient::new(&data.env, &data.token).mint(&data.sender, &large_amount);

    let (id, snap) = measure_invocation(&data.env, || {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &large_amount,
            &1_100u64,
            &1_101u64, // 1-second duration
            &0u32,
        )
    });

    assert_eq!(id, 1);
    // Large values should not cause ceiling blowout beyond what is reasonable.
    assert_budget_ceiling(&snap, 320_000, 60_000, 100, 1_400);
}
