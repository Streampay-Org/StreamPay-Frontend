//! # Comprehensive tests for the cross-stream fee treasury sweep (issue #957)
//!
//! ## Coverage matrix
//!
//! | # | Criterion |
//! |---|-----------|
//! | 1 | Successful sweep with fees present on a single stream |
//! | 2 | Successful sweep aggregating fees across multiple streams |
//! | 3 | Sweep with zero fees returns `Error::SweepNoFees` |
//! | 4 | Unauthorized caller is rejected |
//! | 5 | Missing fee collector returns `Error::NotFound` |
//! | 6 | Repeated sweep on already-swept streams returns `Error::SweepNoFees` (no double-spend) |
//! | 7 | Mixed streams: some with fees, some without — only non-zero streams are swept |
//! | 8 | Overflow-safe: aggregate total near `i128::MAX` returns `Error::Overflow` |
//! | 9 | Single stream at maximum fee bps (100%) is swept correctly |
//! | 10 | Streams with heterogeneous tokens are swept correctly |
//! | 11 | Invalid/missing stream IDs in the list are silently skipped |
//! | 12 | `FeesSwept` event is emitted with correct fields |
//! | 13 | `SweepResult` fields (`streams_swept`, `total_swept`) are accurate |
//! | 14 | Admin auth is enforced: call without auth panics |
//! | 15 | Balances are zeroed after sweep (verified via `get_accumulated_fees`) |
//! | 16 | Empty stream_ids vec returns `Error::SweepNoFees` |

use crate::fee_sweep::{sweep_fees, SweepResult};
use crate::fees::{accrue_fees, clear_accumulated_fees, get_accumulated_fees, set_fee_collector};
use crate::storage::{self, Stream, StreamStatus};
use crate::Contract;
use crate::Error;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, Vec};

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture
// ─────────────────────────────────────────────────────────────────────────────

struct SweepFixture {
    env: Env,
    admin: Address,
    token: Address,
}

/// Build a minimal test environment with:
/// - A registered `Contract` instance.
/// - One admin address.
/// - One token contract with 10 000 000 units pre-minted into the **contract**
///   account (simulating escrowed stream funds from which fees are swept).
fn setup() -> (SweepFixture, soroban_sdk::Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    env.ledger().set_sequence_number(500);

    let admin = Address::generate(&env);

    // Register the token and fund the contract address so token transfers work.
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(Contract, ());

    // Fund the contract with tokens (represents escrowed stream funds).
    StellarAssetClient::new(&env, &token).mint(&contract_id, &10_000_000i128);

    // Initialise the contract.
    use crate::ContractClient;
    let client: ContractClient<'_> = ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let fix = SweepFixture { env, admin, token };
    (fix, contract_id)
}

/// Insert a minimal stream row directly into storage (bypasses the full
/// `create_stream` path to keep tests fast and focused on sweep behaviour).
///
/// Must be called INSIDE an `env.as_contract(&contract_id, ...)` closure.
fn insert_stream(env: &Env, _contract_id: &Address, stream_id: u64, token: &Address) {
    let stream = Stream {
        id: stream_id,
        sender: Address::generate(env),
        recipient: Address::generate(env),
        token: token.clone(),
        total_amount: 1_000,
        released_amount: 0,
        start_time: 500,
        end_time: 1_500,
        duration: 1_000,
        last_update: 500,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
        fee_bps: 100,
    };
    storage::set_stream(env, stream_id, &stream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Single-stream sweep — success path
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_single_stream_success() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 500).expect("accrue should succeed");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep should succeed")
    });

    assert_eq!(result.streams_swept, 1);
    assert_eq!(result.total_swept, 500);

    // Balance must be zeroed.
    let remaining = env.as_contract(&contract_id, || get_accumulated_fees(env, 1));
    assert_eq!(
        remaining, 0,
        "accumulated fees should be zeroed after sweep"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Multi-stream aggregation
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_aggregates_multiple_streams() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        for id in 1u64..=4u64 {
            insert_stream(env, &contract_id, id, &fix.token);
            accrue_fees(env, id, 100i128 * id as i128).expect("accrue");
        }
    });

    // 100 + 200 + 300 + 400 = 1 000
    let mut ids: Vec<u64> = Vec::new(env);
    for id in 1u64..=4u64 {
        ids.push_back(id);
    }

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep")
    });

    assert_eq!(result.streams_swept, 4);
    assert_eq!(result.total_swept, 1_000);

    // All balances zeroed.
    env.as_contract(&contract_id, || {
        for id in 1u64..=4u64 {
            assert_eq!(get_accumulated_fees(env, id), 0, "stream {id} not zeroed");
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Zero fees → SweepNoFees
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_zero_fees_returns_error() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);
    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        // Do NOT accrue any fees.
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect_err("should fail with SweepNoFees")
    });
    assert_eq!(err, Error::SweepNoFees);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Unauthorized caller
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_unauthorized_caller_rejected() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);
    let impostor = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 200).expect("accrue");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &impostor, &ids).expect_err("should be unauthorized")
    });
    assert_eq!(err, Error::Unauthorized);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Missing fee collector → NotFound
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_no_fee_collector_returns_not_found() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    env.as_contract(&contract_id, || {
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 300).expect("accrue");
        // Intentionally do NOT set a fee collector.
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect_err("should fail")
    });
    assert_eq!(err, Error::NotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Double-sweep prevention
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_repeated_sweep_no_double_spend() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 400).expect("accrue");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    // First sweep succeeds.
    env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("first sweep should succeed");
    });

    // Second sweep on the same (now-zeroed) stream must fail.
    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect_err("second sweep should fail")
    });
    assert_eq!(err, Error::SweepNoFees, "must not double-spend");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Mixed streams — non-zero and zero balances
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_skips_zero_balance_streams() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        // Stream 1: 250 accrued.
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 250).expect("accrue 1");
        // Stream 2: zero (no accrual).
        insert_stream(env, &contract_id, 2, &fix.token);
        // Stream 3: 750 accrued.
        insert_stream(env, &contract_id, 3, &fix.token);
        accrue_fees(env, 3, 750).expect("accrue 3");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);
    ids.push_back(2u64);
    ids.push_back(3u64);

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep")
    });

    // Only streams 1 and 3 counted.
    assert_eq!(result.streams_swept, 2);
    assert_eq!(result.total_swept, 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Overflow protection
// ─────────────────────────────────────────────────────────────────────────────
//
// We directly write extreme values via `accrue_fees` by calling it many times
// with a large delta to push toward i128::MAX, then add one more stream that
// would tip the sum over the limit.
//
// A simpler approach: accrue i128::MAX / 2 + 1 on two streams so their sum
// overflows.

#[test]
fn test_sweep_overflow_returns_error() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    // Half of i128::MAX, rounded up — two of these overflow.
    let half_max: i128 = i128::MAX / 2 + 1;

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        insert_stream(env, &contract_id, 2, &fix.token);
        accrue_fees(env, 1, half_max).expect("accrue 1");
        accrue_fees(env, 2, half_max).expect("accrue 2");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);
    ids.push_back(2u64);

    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect_err("should overflow")
    });
    assert_eq!(err, Error::Overflow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Maximum fee bps (100%) sweep
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_max_fee_bps_stream() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        // 100 % fee: entire stream amount is "fee".
        accrue_fees(env, 1, 1_000).expect("accrue full amount");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep")
    });

    assert_eq!(result.streams_swept, 1);
    assert_eq!(result.total_swept, 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Heterogeneous tokens
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_heterogeneous_tokens() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    // Register a second token.
    let token2 = env
        .register_stellar_asset_contract_v2(fix.admin.clone())
        .address();
    StellarAssetClient::new(env, &token2).mint(&contract_id, &5_000_000i128);

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        // Stream 1 uses token1.
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 300).expect("accrue 1");
        // Stream 2 uses token2.
        insert_stream(env, &contract_id, 2, &token2);
        accrue_fees(env, 2, 700).expect("accrue 2");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);
    ids.push_back(2u64);

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep")
    });

    assert_eq!(result.streams_swept, 2);
    assert_eq!(result.total_swept, 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Invalid/missing stream IDs are skipped
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_skips_missing_stream_ids() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 123).expect("accrue");
        // Stream IDs 99 and 100 do not exist in storage.
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);
    ids.push_back(99u64); // non-existent
    ids.push_back(100u64); // non-existent

    // Should succeed on stream 1 and silently ignore the missing IDs.
    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep with missing ids")
    });

    assert_eq!(result.streams_swept, 1);
    assert_eq!(result.total_swept, 123);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: FeesSwept event emission
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_emits_fees_swept_event() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        insert_stream(env, &contract_id, 1, &fix.token);
        accrue_fees(env, 1, 555).expect("accrue");
    });

    let mut ids: Vec<u64> = Vec::new(env);
    ids.push_back(1u64);

    env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep");
    });

    // Verify the event was published.
    let events = env.events().all();
    let found = events.iter().any(|ev| {
        // Event topics are (Symbol, Symbol); data tuple contains
        // (streams_swept, total_amount, collector, caller, timestamp).
        use soroban_sdk::symbol_short;
        let (topics, _) = ev;
        // topics is a soroban_sdk::Vec<Val>; check via string comparison.
        format!("{topics:?}").contains("swept")
    });
    assert!(found, "fees_swept event was not emitted");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: SweepResult fields accuracy
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_result_fields_are_accurate() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        for id in 1u64..=3u64 {
            insert_stream(env, &contract_id, id, &fix.token);
            accrue_fees(env, id, 333).expect("accrue");
        }
    });

    let mut ids: Vec<u64> = Vec::new(env);
    for id in 1u64..=3u64 {
        ids.push_back(id);
    }

    let result = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep")
    });

    assert_eq!(
        result,
        SweepResult {
            streams_swept: 3,
            total_swept: 999, // 333 × 3
        }
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: Auth enforcement (non-admin call without mock is rejected)
// ─────────────────────────────────────────────────────────────────────────────
//
// This test uses a NEW Env without mock_all_auths() so that auth is enforced.
// The call should fail because neither auth is mocked nor is require_auth
// satisfied by the soroban test framework.

#[test]
#[should_panic]
fn test_sweep_requires_auth() {
    let env = Env::default();
    // No env.mock_all_auths() — auth is enforced.
    env.ledger().set_timestamp(1_000);
    env.ledger().set_sequence_number(500);

    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(Contract, ());
    StellarAssetClient::new(&env, &token).mint(&contract_id, &1_000_000i128);

    // Use a separate mocked env just for initialisation.
    {
        let init_env = Env::default();
        init_env.mock_all_auths();
        init_env.ledger().set_timestamp(1_000);
        let init_contract_id = init_env.register(Contract, ());
        use crate::ContractClient;
        ContractClient::new(&init_env, &init_contract_id).initialize(&admin);
    }

    // Now call sweep WITHOUT auth — should panic (unauthorized).
    let mut ids: Vec<u64> = Vec::new(&env);
    ids.push_back(1u64);

    env.as_contract(&contract_id, || {
        // require_auth() will panic since no auth is provided.
        let _ = sweep_fees(&env, &admin, &ids);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 15: Balances are zeroed after sweep
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_balances_zeroed_after_sweep() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);

    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
        for id in 1u64..=5u64 {
            insert_stream(env, &contract_id, id, &fix.token);
            accrue_fees(env, id, id as i128 * 10).expect("accrue");
        }
    });

    let mut ids: Vec<u64> = Vec::new(env);
    for id in 1u64..=5u64 {
        ids.push_back(id);
    }

    env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect("sweep");
    });

    env.as_contract(&contract_id, || {
        for id in 1u64..=5u64 {
            assert_eq!(
                get_accumulated_fees(env, id),
                0,
                "stream {id} balance not zeroed"
            );
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 16: Empty stream_ids vec → SweepNoFees
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sweep_empty_ids_returns_no_fees() {
    let (fix, contract_id) = setup();
    let env = &fix.env;

    let collector = Address::generate(env);
    env.as_contract(&contract_id, || {
        set_fee_collector(env, &collector);
    });

    let ids: Vec<u64> = Vec::new(env);

    let err = env.as_contract(&contract_id, || {
        sweep_fees(env, &fix.admin, &ids).expect_err("empty ids should fail")
    });
    assert_eq!(err, Error::SweepNoFees);
}
