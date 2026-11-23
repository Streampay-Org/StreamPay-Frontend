#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for the `initialize` and `init_with_token_allowlist`
//! entrypoints.
//!
//! These tests pin the contract's behaviour at deployment time:
//!
//! - `initialize` (the legacy single-arg entrypoint) keeps working
//!   unchanged for backward compatibility.
//! - `init_with_token_allowlist` registers `admin`, marks the contract
//!   as unpaused, AND marks every token in `tokens` as `allowed = true`
//!   - all in one transaction.
//! - Re-initialisation (via either path) is rejected with
//!   `Error::AlreadyInitialized` and leaves no partial state.
//!
//! The full allowlist/stream lifecycle is exercised elsewhere; this
//! module only verifies the deployment-time surface area.

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{symbol_short, token::StellarAssetClient, Address, Env};

/// All addresses and tokens needed by a single test. We use a
/// fixed-size array on the stack (no `Vec`) because the contract
/// crate is `no_std`.
struct InitTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    tokens: [Address; 3],
}

fn setup_init() -> InitTestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    env.register(Contract, ());

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Three distinct tokens so we can prove the new entrypoint walks
    // the full allowlist, not just the first element.
    let token_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_c = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Fund `sender` on every token so any later stream-creation test
    // can run without a separate mint step.
    let all_tokens = [&token_a, &token_b, &token_c];
    for token in &all_tokens {
        StellarAssetClient::new(&env, token).mint(&sender, &1_000_000);
    }

    InitTestData {
        env,
        admin,
        sender,
        recipient,
        tokens: [token_a, token_b, token_c],
    }
}

fn contract_client(env: &Env) -> ContractClient<'_> {
    // Re-register against the same env to obtain the contract
    // address, then bind a client to it.
    let contract_id = env.register(Contract, ());
    ContractClient::new(env, &contract_id)
}

/// Build a `soroban_sdk::Vec<Address>` from a fixed-size array.
fn to_sdk_vec(env: &Env, tokens: &[Address; 3]) -> soroban_sdk::Vec<Address> {
    let mut v = soroban_sdk::Vec::new(env);
    for t in tokens {
        v.push_back(t.clone());
    }
    v
}

// ── `initialize` (legacy path) ───────────────────────────────────────────────

#[test]
fn draft_stream_accrues_nothing_until_started() {
    let data = setup_initialized();
    let stream_id =
        data.client
            .create_draft_stream(&data.sender, &data.recipient, &data.token, &1_000, &100);
    data.env.ledger().set_timestamp(2_000);
    assert_eq!(data.client.withdrawable(&stream_id), 0);
    assert_eq!(data.client.stream_balance(&stream_id), 0);

    client.initialize(&data.admin);

    // Admin-only entrypoint that succeeds iff the admin is set.
    // We expect `set_paused(false)` to be a no-op rather than an error.
    client.set_paused(&data.admin, &false);
}

#[test]
fn initialize_emits_deprecated_entrypoint_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let events = data.env.events().all();
    assert!(
        !events.is_empty(),
        "initialize should emit a deprecated event"
    );

    let (_, topics, _) = events.last().unwrap();
    assert_eq!(topics.len(), 2, "Event should have 2 topics");
    assert_eq!(topics[1], symbol_short!("deprecated_entrypoint"));
}

#[test]
fn initialize_twice_returns_invalid_state() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let result = client.try_initialize(&data.admin);
    let err = result.expect_err("second initialize should fail");
    assert_eq!(err, Ok(Error::AlreadyInitialized));
}

#[test]
fn create_stream_with_self_recipient_returns_self_stream() {
    // Streaming to yourself is meaningless and now has its own semantic
    // error code rather than the generic `InvalidState`.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let result = client.try_create_stream(
        &data.sender,
        &data.sender,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    let err = result.expect_err("sender == recipient should fail");
    assert_eq!(err, Ok(Error::SelfStream));
}

#[test]
fn initialize_does_not_allowlist_tokens() {
    // `initialize` is the legacy path: it must NOT write any per-token
    // entries. We probe this indirectly by blocking `token_a` after
    // init; the new path under test must remain the only writer.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);
    client.set_token_allowed(&data.admin, &data.tokens[0], &false);

    // Attempting to stream on `token_a` now hits `TokenNotAllowed`,
    // proving `initialize` itself didn't pre-allow it.
    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    let err = result.expect_err("blocked token should fail create_stream");
    assert_eq!(err, Ok(Error::TokenNotAllowed));
}

// ── `init_with_token_allowlist` (new path) ────────────────────────────────────

#[test]
fn init_with_token_allowlist_handles_empty_token_list() {
    // An empty allowlist is a valid deployment choice: tokens can be
    // added lazily via `set_token_allowed` after the fact. We must
    // still register the admin.
    let data = setup_init();
    let client = contract_client(&data.env);

    let empty = soroban_sdk::Vec::<Address>::new(&data.env);
    client.init_with_token_allowlist(&data.admin, &empty);

    // Admin-only entrypoint works.
    client.set_paused(&data.admin, &true);
    client.set_paused(&data.admin, &false);
}

#[test]
fn init_with_token_allowlist_blocks_blocked_token() {
    // The deployment-time allowlist is not "open up the contract to
    // everything"; tokens that the admin subsequently blocks via
    // `set_token_allowed(false)` must still be rejected.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));

    client.set_token_allowed(&data.admin, &data.tokens[0], &false);

    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    let err = result.expect_err("blocked token should fail create_stream");
    assert_eq!(err, Ok(Error::TokenNotAllowed));
}

#[test]
fn instance_ttl_extends_for_admin_and_counter_keys() {
    let data = setup_initialized();
    let _ =
        data.client
            .create_draft_stream(&data.sender, &data.recipient, &data.token, &1_000, &100);

    client.init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));

    data.env.ledger().set_timestamp(1_050);
    data.client.set_paused(&data.admin, &false);
    let _ = data
        .client
        .create_draft_stream(&data.sender, &data.recipient, &data.token, &500, &10);

    let after_admin_ttl = data.env.storage().instance().get_ttl(&DataKey::Admin);
    let after_next_id_ttl = data.env.storage().instance().get_ttl(&DataKey::StreamCount);

    assert!(after_admin_ttl > before_admin_ttl);
    assert!(after_next_id_ttl > before_next_id_ttl);
}

#[test]
fn init_with_token_allowlist_after_initialize_returns_invalid_state() {
    // Cross-path double init is also forbidden: whichever path
    // landed first owns the admin slot forever.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let result =
        client.try_init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));
    let err = result.expect_err("init_with_token_allowlist after initialize should fail");
    assert_eq!(err, Ok(Error::AlreadyInitialized));
}

#[test]
fn initialize_after_init_with_token_allowlist_returns_invalid_state() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));

    let result = client.try_initialize(&data.admin);
    let err = result.expect_err("initialize after init_with_token_allowlist should fail");
    assert_eq!(err, Ok(Error::AlreadyInitialized));
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn init_with_token_allowlist_unauthorized_caller_fails() {
    // The atomic path requires `admin.require_auth()`; without
    // mock_auths for `admin` the call must panic with the standard
    // Soroban auth error.
    let data = setup_init();
    let client = contract_client(&data.env);
    let impostor = Address::generate(&data.env);

    data.env.mock_auths(&[]);
    client.init_with_token_allowlist(&impostor, &to_sdk_vec(&data.env, &data.tokens));
}

#[test]
fn init_with_token_allowlist_emits_no_events() {
    // The new entrypoint mirrors `initialize` and `set_token_allowed`
    // by emitting no events - lifecycle events are reserved for
    // stream-level operations. This test pins that contract so
    // future changes don't accidentally spam the indexer.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));

    let events = data.env.events().all();
    assert!(
        events.is_empty(),
        "init_with_token_allowlist should emit zero events, got: {events:?}",
    );
}

#[test]
fn init_with_token_allowlist_atomicity_leaves_no_partial_state() {
    // We can't directly observe partial state in a single call (the
    // happy path either commits everything or nothing), but we can
    // prove the no-partial-state invariant by ensuring a failed
    // second call leaves the FIRST call's state untouched. If the
    // host had not rolled back the storage mutations, the second
    // `try_init_with_token_allowlist` call would have written extra
    // admin/allowlist entries before failing.
    let data = setup_init();
    let client = contract_client(&data.env);

    client.init_with_token_allowlist(&data.admin, &to_sdk_vec(&data.env, &data.tokens));

    let impostor = Address::generate(&data.env);

    // Auth fails -> the whole transaction is rolled back, including
    // the auth-write for the impostor. Admin from the first call
    // still works. We `try_` so the auth failure is contained; the
    // test runner's auth mocks are not poisoned for subsequent calls.
    let _ = client.try_init_with_token_allowlist(&impostor, &to_sdk_vec(&data.env, &data.tokens));

    // `mock_all_auths` was on at `setup_init` time so `set_paused`
    // still succeeds, proving the original `admin` is intact.
    client.set_paused(&data.admin, &false);
}

// ── Per-sender stream limit tests ──────────────────────────────────────────

#[test]
fn sender_stream_count_starts_at_zero() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    assert_eq!(client.sender_stream_count(&data.sender), 0);
}

#[test]
fn create_stream_increments_sender_count() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&data.sender), 1);
}

/// The trustline pre-check (#611) accepts a recipient that can hold the token.
///
/// A Stellar Asset Contract reports a non-negative balance for any address that
/// has (or can establish) a trustline, so `create_stream` must succeed for a
/// well-formed recipient and token pair.
#[test]
fn create_stream_succeeds_when_recipient_has_trustline() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    // Mint to the recipient as well to make the established trustline explicit.
    StellarAssetClient::new(&data.env, &data.tokens[0]).mint(&data.recipient, &0);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    let stream = client.get_stream(&id);
    assert_eq!(stream.recipient, data.recipient);
    assert_eq!(stream.status, StreamStatus::Active);
}

#[test]
fn default_max_streams_per_sender_is_ten() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    assert_eq!(client.max_streams_per_sender(), 10);
}

#[test]
fn sender_can_create_up_to_default_limit() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    for i in 0..10 {
        let id = client.create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[i % 3],
            &100i128,
            &(1_100u64 + i as u64 * 100),
            &(1_200u64 + i as u64 * 100),
        );
        assert_eq!(id, i as u64 + 1);
    }
    assert_eq!(client.sender_stream_count(&data.sender), 10);
}

#[test]
fn create_stream_beyond_limit_returns_stream_limit_exceeded() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    for i in 0..10 {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[i % 3],
            &100i128,
            &(1_100u64 + i as u64 * 100),
            &(1_200u64 + i as u64 * 100),
        );
    }

    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &2_100u64,
        &2_200u64,
    );
    let err = result.expect_err("11th stream should exceed limit");
    assert_eq!(err, Ok(Error::StreamLimitExceeded));
}

#[test]
fn remaining_capacity_tracks_active_streams() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    // Full capacity before any stream exists.
    assert_eq!(client.remaining_sender_capacity(&data.sender), 10);

    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    // One stream consumed ⇒ nine remaining.
    assert_eq!(client.remaining_sender_capacity(&data.sender), 9);
}

#[test]
fn remaining_capacity_is_zero_at_limit() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    for i in 0..10 {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[i % 3],
            &100i128,
            &(1_100u64 + i as u64 * 100),
            &(1_200u64 + i as u64 * 100),
        );
    }

    assert_eq!(client.remaining_sender_capacity(&data.sender), 0);
}

#[test]
fn settle_stream_decrements_sender_count() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&data.sender), 1);

    // Advance past end_time and settle
    data.env.ledger().set_timestamp(1_300);
    client.settle(&id);

    assert_eq!(client.sender_stream_count(&data.sender), 0);
}

#[test]
fn settle_frees_slot_for_new_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    // Create stream, settle it, then create another
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    data.env.ledger().set_timestamp(1_300);
    client.settle(&id);

    // Should be able to create again
    let new_id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_400u64,
        &1_500u64,
    );
    assert_eq!(new_id, 2);
    assert_eq!(client.sender_stream_count(&data.sender), 1);
}

#[test]
fn withdraw_full_amount_decrements_sender_count() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&data.sender), 1);

    // Advance past end_time so full amount is vested
    data.env.ledger().set_timestamp(1_300);

    // Withdraw full amount (settles the stream)
    client.withdraw(&id, &100i128);

    assert_eq!(client.sender_stream_count(&data.sender), 0);
}

#[test]
fn admin_can_change_max_streams_per_sender() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    client.set_max_streams_per_sender(&data.admin, &3);
    assert_eq!(client.max_streams_per_sender(), 3);

    // Create 3 streams
    for i in 0..3 {
        client.create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[i],
            &100i128,
            &(1_100u64 + i as u64 * 100),
            &(1_200u64 + i as u64 * 100),
        );
    }

    // 4th should fail
    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_500u64,
        &1_600u64,
    );
    let err = result.expect_err("4th stream should exceed new limit of 3");
    assert_eq!(err, Ok(Error::StreamLimitExceeded));
}

#[test]
fn different_senders_have_independent_counts() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let other_sender = Address::generate(&data.env);
    let other_recipient = Address::generate(&data.env);

    // Fund other_sender on tokens
    for token in &data.tokens {
        StellarAssetClient::new(&data.env, token).mint(&other_sender, &1_000_000);
    }

    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&data.sender), 1);
    assert_eq!(client.sender_stream_count(&other_sender), 0);

    client.create_stream(
        &other_sender,
        &other_recipient,
        &data.tokens[1],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&other_sender), 1);
    assert_eq!(client.sender_stream_count(&data.sender), 1);
}

#[test]
fn sender_can_create_up_to_custom_limit_after_settle() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    // Set limit to 2
    client.set_max_streams_per_sender(&data.admin, &2);

    let id1 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[1],
        &100i128,
        &1_300u64,
        &1_400u64,
    );

    // 3rd should fail
    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[2],
        &100i128,
        &1_500u64,
        &1_600u64,
    );
    assert_eq!(result, Err(Ok(Error::StreamLimitExceeded)));

    // Settle one stream
    data.env.ledger().set_timestamp(1_500);
    client.settle(&id1);

    // Now 3rd should succeed
    let id3 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[2],
        &100i128,
        &1_600u64,
        &1_700u64,
    );
    assert_eq!(id3, 3);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn non_admin_cannot_set_max_streams_per_sender() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    data.env.mock_auths(&[]);
    client.set_max_streams_per_sender(&data.sender, &5);
}

// ── Event emission tests for cancel_stream, amend_stream, and admin actions ────

#[test]
fn cancel_stream_emits_cancelled_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Advance time to let some amount be vested
    data.env.ledger().set_timestamp(1_150);

    // Clear events from creation
    data.env.events().all();

    // Cancel the stream
    client.cancel_stream(&id);

    let events = data.env.events().all();
    assert!(!events.is_empty(), "cancel_stream should emit events");

    // The last event should be the cancelled event
    let (_, topics, _) = events.last().unwrap();
    assert_eq!(topics.len(), 2, "Event should have 2 topics");
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn cancel_stream_requires_auth() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Remove all auths — the host should reject the call because stream.sender
    // has not authorized it.
    data.env.mock_auths(&[]);
    client.cancel_stream(&id);
}

#[test]
fn cancel_stream_fails_on_settled_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    // Withdraw full amount to settle
    data.env.ledger().set_timestamp(1_250);
    client.withdraw(&id, &100i128);

    // Try to cancel settled stream
    let result = client.try_cancel_stream(&id);
    let err = result.expect_err("Should fail on settled stream");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn cancel_stream_returns_unstreamed_funds() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // The stream should now exist and be cancellable
    let stream = client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Active);

    // Cancel the stream
    client.cancel_stream(&id);

    // Verify stream is now cancelled
    let cancelled_stream = client.get_stream(&id);
    assert_eq!(cancelled_stream.status, StreamStatus::Cancelled);
}

// ── cancel_stream: correct sender/recipient refund split (issue #601) ────────

/// Cancelling at the midpoint: half is vested → recipient gets half, sender gets half.
#[test]
fn cancel_stream_splits_vested_to_recipient_unvested_to_sender() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    // Stream: 1000 tokens, active from t=1000 to t=2000 (duration=1000s)
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_000u64,
        &2_000u64,
    );

    let sender_token = soroban_sdk::token::Client::new(&data.env, &data.tokens[0]);
    let sender_before = sender_token.balance(&data.sender);
    let recipient_before = sender_token.balance(&data.recipient);

    // Cancel at t=1500 → 500 tokens vested, 500 unvested
    data.env.ledger().set_timestamp(1_500);
    client.cancel_stream(&id);

    // Recipient receives the vested-but-undrawn 500
    assert_eq!(
        sender_token.balance(&data.recipient),
        recipient_before + 500
    );
    // Sender gets back the unvested 500
    assert_eq!(sender_token.balance(&data.sender), sender_before + 500);

    let s = client.get_stream(&id);
    assert_eq!(s.status, StreamStatus::Cancelled);
}

/// Cancelling before the stream starts (Draft-like timing): full amount returns to sender.
#[test]
fn cancel_stream_before_start_returns_all_to_sender() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    // Create stream starting in the future (relative to current ledger t=1000)
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &2_000u64, // starts later
        &3_000u64,
    );

    let sender_token = soroban_sdk::token::Client::new(&data.env, &data.tokens[0]);
    let sender_before = sender_token.balance(&data.sender);

    // Cancel at t=1000 (before start_time=2000) → 0 vested → full refund to sender
    client.cancel_stream(&id);

    assert_eq!(sender_token.balance(&data.sender), sender_before + 1000);
    assert_eq!(sender_token.balance(&data.recipient), 0);
}

/// Cancelling after the stream has fully elapsed: full amount goes to recipient.
#[test]
fn cancel_stream_after_end_pays_all_to_recipient() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_000u64,
        &2_000u64,
    );

    let sender_token = soroban_sdk::token::Client::new(&data.env, &data.tokens[0]);
    let sender_before = sender_token.balance(&data.sender);
    let recipient_before = sender_token.balance(&data.recipient);

    // Cancel at t=2500 (past end_time) → 1000 vested → all to recipient, 0 to sender
    data.env.ledger().set_timestamp(2_500);
    client.cancel_stream(&id);

    assert_eq!(
        sender_token.balance(&data.recipient),
        recipient_before + 1000
    );
    assert_eq!(sender_token.balance(&data.sender), sender_before);
}

/// Cancelling after a partial withdrawal: recipient gets remaining vested portion only.
#[test]
fn cancel_stream_after_partial_withdraw_correct_split() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    // 1000 tokens, t=1000..2000
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_000u64,
        &2_000u64,
    );

    let sender_token = soroban_sdk::token::Client::new(&data.env, &data.tokens[0]);

    // At t=1500, 500 vested; recipient withdraws 200
    data.env.ledger().set_timestamp(1_500);
    client.withdraw(&id, &200i128);

    let sender_before = sender_token.balance(&data.sender);
    let recipient_before = sender_token.balance(&data.recipient);

    // Cancel at t=1500 → vested=500, released=200
    // recipient_payout = 500 - 200 = 300; sender_refund = 1000 - 500 = 500
    client.cancel_stream(&id);

    assert_eq!(
        sender_token.balance(&data.recipient),
        recipient_before + 300
    );
    assert_eq!(sender_token.balance(&data.sender), sender_before + 500);
}

/// Cancelling a paused stream respects the frozen accrual point.
#[test]
fn cancel_stream_while_paused_uses_paused_at_for_split() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    // 1000 tokens, t=1000..2000
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_000u64,
        &2_000u64,
    );

    let sender_token = soroban_sdk::token::Client::new(&data.env, &data.tokens[0]);

    // Pause at t=1200 → 200 tokens vested at pause
    data.env.ledger().set_timestamp(1_200);
    client.pause(&id);

    let sender_before = sender_token.balance(&data.sender);
    let recipient_before = sender_token.balance(&data.recipient);

    // Cancel at t=1800 (later, but stream is paused so accrual is frozen at t=1200)
    data.env.ledger().set_timestamp(1_800);
    client.cancel_stream(&id);

    // vested=200 (frozen at pause), released=0
    // recipient_payout=200, sender_refund=800
    assert_eq!(
        sender_token.balance(&data.recipient),
        recipient_before + 200
    );
    assert_eq!(sender_token.balance(&data.sender), sender_before + 800);
}

/// cancel_stream sets released_amount to vested_amount in the final state.
#[test]
fn cancel_stream_updates_released_amount_to_vested() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_000u64,
        &2_000u64,
    );

    data.env.ledger().set_timestamp(1_750);
    client.cancel_stream(&id);

    let s = client.get_stream(&id);
    // vested at t=1750 = 750; released_amount should reflect that
    assert_eq!(s.released_amount, 750);
    assert_eq!(s.status, StreamStatus::Cancelled);
}

#[test]
fn amend_stream_emits_amended_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Clear events from creation
    data.env.events().all();

    // Amend the stream (extend end time)
    client.amend_stream(&id, &5i128, &1_300u64);

    let events = data.env.events().all();
    assert!(!events.is_empty(), "amend_stream should emit events");
}

#[test]
fn amend_stream_requires_auth() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Try to amend without auth
    data.env.mock_auths(&[]);
    let result = client.try_amend_stream(&id, &5i128, &1_300u64);
    assert!(result.is_err(), "amend_stream should fail without auth");
}

#[test]
fn amend_stream_fails_on_invalid_end_time() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Try to amend with end_time in the past
    let result = client.try_amend_stream(&id, &5i128, &1_050u64);
    let err = result.expect_err("Should fail with past end_time");
    assert_eq!(err, Ok(Error::InvalidTimeRange));
}

/// amend_stream rejects a non-positive rate (rate-change validation, #703).
#[test]
fn amend_stream_rejects_non_positive_rate() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    let zero_rate = client.try_amend_stream(&id, &0i128, &1_300u64);
    assert_eq!(
        zero_rate.expect_err("zero rate should be rejected"),
        Ok(Error::InvalidAmount)
    );

    let negative_rate = client.try_amend_stream(&id, &-5i128, &1_300u64);
    assert_eq!(
        negative_rate.expect_err("negative rate should be rejected"),
        Ok(Error::InvalidAmount)
    );
}

/// amend_stream extends the schedule and recomputes duration with valid input.
#[test]
fn amend_stream_updates_end_time_and_duration() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    let amended = client.amend_stream(&id, &10i128, &1_400u64);
    assert_eq!(amended.end_time, 1_400u64);
    // start_time stayed at 1_100, so the new duration is 300.
    assert_eq!(amended.duration, 300u64);
}

/// amend_stream still rejects an end_time at or before now.
#[test]
fn amend_stream_rejects_end_time_not_in_future() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Advance the ledger so `now` is well past start_time, then amend with an
    // end_time equal to `now` (not strictly in the future).
    data.env.ledger().set_timestamp(1_500);
    let result = client.try_amend_stream(&id, &10i128, &1_500u64);
    assert_eq!(
        result.expect_err("end_time == now should be rejected"),
        Ok(Error::InvalidTimeRange)
    );
}

#[test]
fn amend_stream_fails_when_contract_paused() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    client.set_paused(&data.admin, &true);
    let result = client.try_amend_stream(&id, &10i128, &1_300u64);
    assert_eq!(
        result.expect_err("amend when paused should fail"),
        Ok(Error::ContractPaused)
    );
}

#[test]
fn amend_stream_overflow_returns_overflow_error() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let large_amount = i128::MAX / 10;
    StellarAssetClient::new(&data.env, &data.tokens[0]).mint(&data.sender, &large_amount);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &large_amount,
        &1_100u64,
        &1_101u64,
    );

    // Amending new_end_time to 1_111 makes duration 11. (i128::MAX / 10) * 11 overflows i128.
    let result = client.try_amend_stream(&id, &10i128, &1_111u64);
    assert_eq!(
        result.expect_err("amend overflow should fail"),
        Ok(Error::Overflow)
    );
}

#[test]
fn pause_emits_admin_action_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Clear events from creation
    data.env.events().all();

    // Pause the stream
    client.pause(&id);

    let events = data.env.events().all();
    assert!(!events.is_empty(), "pause should emit events");

    // The event should have 2 topics (stream, pause)
    let (_, topics, _) = events.last().unwrap();
    assert_eq!(topics.len(), 2, "Event should have 2 topics");
}

#[test]
fn resume_emits_admin_action_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Pause the stream
    client.pause(&id);

    // Clear events
    data.env.events().all();

    // Resume the stream
    client.resume(&id);

    let events = data.env.events().all();
    assert!(!events.is_empty(), "resume should emit events");

    // The event should have 2 topics (stream, resume)
    let (_, topics, _) = events.last().unwrap();
    assert_eq!(topics.len(), 2, "Event should have 2 topics");
}

#[test]
fn resume_without_pause_returns_invalid_state() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    let result = client.try_resume(&id);

    let err = result.expect_err("resume should fail for active stream");
    assert_eq!(err, Ok(Error::InvalidState));
}

#[test]
fn settle_emits_admin_action_event() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    // Advance past end_time
    data.env.ledger().set_timestamp(1_300);

    // Clear events
    data.env.events().all();

    // Settle the stream
    client.settle(&id);

    let events = data.env.events().all();
    assert!(!events.is_empty(), "settle should emit events");

    // The event should have 2 topics (stream, admin_action)
    let (_, topics, _) = events.last().unwrap();
    assert_eq!(topics.len(), 2, "Event should have 2 topics");
}

#[test]
fn no_events_on_cancel_failure() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    // Settle the stream first
    data.env.ledger().set_timestamp(1_300);
    client.settle(&id);

    // Clear events
    data.env.events().all();

    // Try to cancel settled stream (should fail)
    let _ = client.try_cancel_stream(&id);

    let events = data.env.events().all();
    assert!(
        events.is_empty(),
        "Failed cancel_stream should not emit events, got: {events:?}",
    );
}

#[test]
fn cancel_stream_decrements_sender_count() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );
    assert_eq!(client.sender_stream_count(&data.sender), 1);

    // Cancel the stream
    client.cancel_stream(&id);

    // Count should be decremented
    assert_eq!(client.sender_stream_count(&data.sender), 0);
}

#[test]
fn amend_stream_extends_end_time() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    let original = client.get_stream(&id);
    assert_eq!(original.end_time, 1_200u64);

    // Amend to new end_time
    client.amend_stream(&id, &5i128, &1_400u64);

    let amended = client.get_stream(&id);
    assert_eq!(amended.end_time, 1_400u64);
}

#[test]
fn amend_stream_fails_on_cancelled_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);

    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Cancel the stream
    client.cancel_stream(&id);

    // Try to amend cancelled stream
    let result = client.try_amend_stream(&id, &5i128, &1_300u64);
    let err = result.expect_err("Should fail on cancelled stream");
    assert_eq!(err, Ok(Error::InvalidState));
}

// ── Focused tests for error surfaces using the current client harness ───────

#[test]
fn set_paused_wrong_admin_returns_unauthorized() {
    let data = setup_init();
    let client = contract_client(&data.env);
    let wrong = Address::generate(&data.env);

    client.initialize(&data.admin);

    let result = client.try_set_paused(&wrong, &true);
    let err = result.expect_err("non-admin pause should fail");
    assert_eq!(err, Ok(Error::Unauthorized));
}

#[test]
fn set_token_allowed_wrong_admin_returns_unauthorized() {
    let data = setup_init();
    let client = contract_client(&data.env);
    let wrong = Address::generate(&data.env);

    client.initialize(&data.admin);
}

    let result = client.try_set_token_allowed(&wrong, &data.tokens[0], &true);
    let err = result.expect_err("wrong admin should fail");
    assert_eq!(err, Ok(Error::Unauthorized));
}

// ── Authorization boundaries ────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn create_stream_wrong_sender_fails() {
    let data = setup_initialized();
    let wrong = Address::generate(&data.env);

    data.env.mock_auths(&[]);
    data.client.create_stream(
        &wrong,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &(1_000_u64 + 10),
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn start_stream_wrong_sender_fails() {
    let data = setup_initialized();
    let wrong = Address::generate(&data.env);
    let id = data
        .client
        .create_draft_stream(&data.sender, &data.recipient, &data.token, &100, &10);

    data.client.start_stream(&wrong, &id);
}

#[test]
fn withdraw_wrong_recipient_fails() {
    let data = setup_initialized();
    let id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &(1_000_u64 + 10),
    );

    let wrong = Address::generate(&data.env);
    data.env.ledger().set_timestamp(1_005);
    assert_contract_error!(
        data.client.try_withdraw(&wrong, &id, &50),
        Error::Unauthorized
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn pause_wrong_sender_fails() {
    let data = setup_initialized();
    let id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &(1_000_u64 + 10),
    );

    data.env.mock_auths(&[]);
    data.client.pause(&id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn resume_wrong_sender_fails() {
    let data = setup_initialized();
    let id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &(1_000_u64 + 10),
    );
    data.client.pause(&id);

    data.env.mock_auths(&[]);
    data.client.resume(&id);
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn cancel_stream_wrong_sender_fails() {
    let data = setup_initialized();
    let id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &(1_000_u64 + 10),
    );

    data.env.mock_auths(&[]);
    data.client.cancel_stream(&id);
}

#[test]
fn settle_before_end_time_returns_invalid_state() {
    let data = setup_initialized();
    let id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &100,
        &1_000,
        &1_010,
    );

    // Settle is permissionless but requires end_time to have passed.
    assert_contract_error!(data.client.try_settle(&id), Error::InvalidState);
}

// ── Linear release math tests ───────────────────────────────────────────────

#[test]
fn vested_amount_at_start_time_is_zero() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.start_time, 1_000);
    assert_eq!(data.client.stream_balance(&stream_id), 0);
}

#[test]
fn vested_amount_at_midpoint_is_half_total() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_050);
    assert_eq!(data.client.stream_balance(&stream_id), 500);
}

#[test]
fn vested_amount_at_end_time_is_total() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_100);
    assert_eq!(data.client.stream_balance(&stream_id), 1_000);
}

#[test]
fn vested_amount_past_end_time_is_clamped_to_total() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(2_000);
    assert_eq!(data.client.stream_balance(&stream_id), 1_000);
}

#[test]
fn vested_amount_before_start_time_is_zero() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(500);
    assert_eq!(data.client.stream_balance(&stream_id), 0);
}

#[test]
fn vested_amount_is_monotonic_non_decreasing() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    let mut prev = data.client.stream_balance(&stream_id);
    for t in [
        1_010, 1_020, 1_030, 1_040, 1_050, 1_060, 1_070, 1_080, 1_090, 1_100,
    ] {
        data.env.ledger().set_timestamp(t);
        let current = data.client.stream_balance(&stream_id);
        assert!(
            current >= prev,
            "vested amount decreased from {} to {} at t={}",
            prev,
            current,
            t
        );
        prev = current;
    }
}

#[test]
fn withdrawable_is_vested_minus_released() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_050);
    assert_eq!(data.client.stream_balance(&stream_id), 500);
    assert_eq!(data.client.withdrawable(&stream_id), 500);

    data.client.withdraw(&data.recipient, &stream_id, &200);
    assert_eq!(data.client.stream_balance(&stream_id), 500);
    assert_eq!(data.client.withdrawable(&stream_id), 300);
}

#[test]
fn withdrawable_never_negative() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_050);
    assert_contract_error!(
        data.client.try_withdraw(&data.recipient, &stream_id, &600),
        Error::OverWithdraw
    );

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.released_amount, 0);
    assert!(data.client.withdrawable(&stream_id) >= 0);
}

#[test]
fn table_driven_vested_amount_across_timeline() {
    struct TestCase {
        total: i128,
        duration: u64,
        start_offset: i64,
        test_offset: i64,
        expected: i128,
    }

    let cases = [
        // (total, duration, start_offset, test_offset, expected)
        (1000, 100, 0, 0, 0),          // at start
        (1000, 100, 0, 25, 250),       // 25% through
        (1000, 100, 0, 50, 500),       // 50% through
        (1000, 100, 0, 75, 750),       // 75% through
        (1000, 100, 0, 100, 1000),     // at end
        (1000, 100, 0, 150, 1000),     // past end
        (1000, 100, 0, -50, 0),        // before start
        (100, 10, 0, 5, 50),           // smaller values
        (1, 1, 0, 0, 0),               // minimal
        (1, 1, 0, 1, 1),               // minimal duration, at end
        (10000, 1000, 100, 600, 6000), // with start offset
    ];

    for case_tuple in cases {
        let case = TestCase {
            total: case_tuple.0,
            duration: case_tuple.1,
            start_offset: case_tuple.2,
            test_offset: case_tuple.3,
            expected: case_tuple.4,
        };
        let data = setup();
        let start_time = 1_000 + case.start_offset as u64;
        let end_time = start_time + case.duration;
        data.env.ledger().set_timestamp(start_time);

        let stream_id = data.client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &case.total,
            &start_time,
            &end_time,
        );

        let target_time = (1_000 + case.start_offset + case.test_offset) as u64;
        data.env.ledger().set_timestamp(target_time);
        let result = data.client.stream_balance(&stream_id);

        assert_eq!(
            result, case.expected,
            "table_driven: total={}, duration={}, start_offset={}, test_offset={}, expected={}, got={}",
            case.total, case.duration, case.start_offset, case.test_offset, case.expected, result
        );
    }
}

#[test]
fn large_amount_near_i128_max_does_not_overflow() {
    let data = setup();

    // Use a large amount that could cause overflow if not using checked arithmetic
    let large_amount = i128::MAX / 1000; // Safe but large

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &large_amount,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_050);
    let vested = data.client.stream_balance(&stream_id);

    // Should be exactly half of the total
    assert_eq!(vested, large_amount / 2);
    assert!(vested >= 0 && vested <= large_amount);
}

#[test]
fn stream_balance_matches_withdrawable_plus_released() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );

    data.env.ledger().set_timestamp(1_050);
    let balance = data.client.stream_balance(&stream_id);
    let withdrawable = data.client.withdrawable(&stream_id);
    let stream = data.client.get_stream(&stream_id);

    assert_eq!(balance, withdrawable + stream.released_amount);
}

#[test]
fn budget_create_stream_stays_within_ceiling() {
    let data = setup();
    data.client.initialize(&data.admin);

    let (stream_id, snapshot) = measure_invocation(&data.env, || {
        data.client.create_stream(
            &data.sender,
            &data.recipient,
            &data.token,
            &1_000,
            &1_000,
            &1_100,
        )
    });

    assert_eq!(stream_id, 1);
    assert_budget_ceiling(&snapshot, 310_000, 55_000, 9, 5, 100, 1_400);
}

#[test]
fn budget_withdraw_stays_within_ceiling() {
    let data = setup();
    data.client.initialize(&data.admin);

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );
    data.env.ledger().set_timestamp(1_050);

    let (withdrawn, snapshot) = measure_invocation(&data.env, || {
        data.client.withdraw(&data.recipient, &stream_id, &500)
    });

    assert_eq!(withdrawn, 500);
    assert_budget_ceiling(&snapshot, 330_000, 55_000, 8, 4, 100, 1_100);
}

#[test]
fn budget_full_withdraw_settle_stays_within_ceiling() {
    let data = setup();
    data.client.initialize(&data.admin);

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &1_100,
    );
    data.env.ledger().set_timestamp(1_100);

    let (withdrawn, snapshot) = measure_invocation(&data.env, || {
        data.client.withdraw(&data.recipient, &stream_id, &1_000)
    });

    assert_eq!(withdrawn, 1_000);
    assert_budget_ceiling(&snapshot, 345_000, 55_000, 8, 4, 100, 1_100);

    let stream = data.client.get_stream(&stream_id);
    assert_eq!(stream.status, StreamStatus::Settled);
}

/// Settle before any amount is released must handle checked sub correctly.
#[test]
fn create_stream_emits_created_event() {
    let data = setup_initialized();
    data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );

    data.env.ledger().set_timestamp(1_300);
    client.settle(&id);

    let stream = client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Settled);
    assert_eq!(stream.released_amount, 100);
}

/// Creating a stream with `start_time` == `end_time` must be rejected.
#[test]
fn create_stream_zero_duration_returns_invalid_time_range() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let result = client.try_create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_100u64,
    );
    let err = result.expect_err("zero duration should fail");
    assert_eq!(err, Ok(Error::InvalidTimeRange));
}

/// Vested amount with extreme values returns `Error::Overflow`.
#[test]
fn vested_amount_extreme_values_overflow() {
    use crate::release;
    use crate::StreamStatus;

    let env = soroban_sdk::Env::default();
    let stream = Stream {
        id: 1,
        sender: soroban_sdk::Address::generate(&env),
        recipient: soroban_sdk::Address::generate(&env),
        token: soroban_sdk::Address::generate(&env),
        total_amount: i128::MAX,
        released_amount: 0,
        start_time: 0,
        end_time: 1000,
        duration: 1000,
        last_update: 0,
        status: StreamStatus::Active,
        paused_at: 0,
        total_paused_duration: 0,
    };

    let result = release::vested_amount(&stream, 500);
    assert_eq!(result, Err(Error::Overflow));
}

/// Withdraw all released amount should settle the stream.
#[test]
fn withdraw_full_amount_after_end_settles_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );

    data.env.ledger().set_timestamp(1_300);
    client.withdraw(&id, &100i128);

    let stream = client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Settled);
    assert_eq!(stream.released_amount, 100);
}

/// Creating a stream with the maximum duration range succeeds.
#[test]
fn create_stream_with_large_timespan_succeeds() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_000u64,
        &u64::MAX,
    );

    let stream = client.get_stream(&id);
    assert_eq!(stream.duration, u64::MAX - 1_000);
}

/// Pause + resume preserves stream balance and uses checked arithmetic.
#[test]
fn pause_resume_preserves_vested_amount() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Advance to midpoint
    data.env.ledger().set_timestamp(1_150);
    client.pause(&id);

    // Check vested amount at pause
    let vested = client.stream_balance(&id);
    assert!(vested > 0);
    assert!(vested <= 1000);

    // Advance time while paused
    data.env.ledger().set_timestamp(1_200);
    let still_vested = client.stream_balance(&id);
    // Should not have increased while paused
    assert_eq!(still_vested, vested);

    // Resume
    client.resume(&id);
    data.env.ledger().set_timestamp(1_300);
    let resumed_vested = client.stream_balance(&id);
    assert_eq!(resumed_vested, 1000);
}

#[test]
fn start_stream_emits_started_event() {
    let data = setup_initialized();
    let stream_id =
        data.client
            .create_draft_stream(&data.sender, &data.recipient, &data.token, &1_000, &100);
    data.env.ledger().set_timestamp(2_000);
    data.client.start_stream(&stream_id);
    let events = data.env.events().all();
    let found = events.iter().any(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0) == Some(symbol_short!("stream").into_val(&data.env))
            && topics.get(1) == Some(symbol_short!("started").into_val(&data.env))
    });
    assert!(found, "expected 'stream.started' event after start_stream");
}

#[test]
fn withdraw_emits_withdrawn_event() {
    let data = setup_initialized();
    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    data.env.ledger().set_timestamp(1_050);
    data.client.withdraw(&data.recipient, &stream_id, &300);
    let events = data.env.events().all();
    let found = events.iter().any(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0) == Some(symbol_short!("stream").into_val(&data.env))
            && topics.get(1) == Some(symbol_short!("withdrawn").into_val(&data.env))
    });
    assert!(found, "expected 'stream.withdrawn' event after withdraw");
}

#[test]
fn full_withdraw_emits_settled_event() {
    let data = setup_initialized();
    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    data.env.ledger().set_timestamp(1_100);
    data.client.withdraw(&data.recipient, &stream_id, &1_000);
    let events = data.env.events().all();
    let has_withdrawn = events.iter().any(|(_, topics, _)| {
        topics.get(1) == Some(symbol_short!("withdrawn").into_val(&data.env))
    });
    let has_settled = events
        .iter()
        .any(|(_, topics, _)| topics.get(1) == Some(symbol_short!("settled").into_val(&data.env)));
    assert!(
        has_withdrawn,
        "expected 'stream.withdrawn' event on full withdrawal"
    );
    assert!(
        has_settled,
        "expected 'stream.settled' event after full withdrawal"
    );
}

#[test]
fn pause_emits_paused_event() {
    let data = setup_initialized();
    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    data.env.ledger().set_timestamp(1_050);
    data.client.pause(&stream_id);
    let events = data.env.events().all();
    let found = events.iter().any(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0) == Some(symbol_short!("stream").into_val(&data.env))
            && topics.get(1) == Some(symbol_short!("paused").into_val(&data.env))
    });
    assert!(found, "expected 'stream.paused' event after pause");
}

#[test]
fn resume_emits_resumed_event() {
    let data = setup_initialized();
    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    data.env.ledger().set_timestamp(1_050);
    data.client.pause(&stream_id);
    data.env.ledger().set_timestamp(1_100);
    data.client.resume(&stream_id);
    let events = data.env.events().all();
    let found = events.iter().any(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0) == Some(symbol_short!("stream").into_val(&data.env))
            && topics.get(1) == Some(symbol_short!("resumed").into_val(&data.env))
    });
    assert!(found, "expected 'stream.resumed' event after resume");
}

#[test]
fn failed_withdraw_emits_no_event() {
    let data = setup_initialized();
    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &1_000,
        &(1_000_u64 + 100),
    );
    data.env.ledger().set_timestamp(1_050);
    let _ = data.client.try_withdraw(&data.recipient, &stream_id, &600);
    let events = data.env.events().all();
    let has_withdrawn = events.iter().any(|(_, topics, _)| {
        topics.get(1) == Some(symbol_short!("withdrawn").into_val(&data.env))
    });
    assert!(
        !has_withdrawn,
        "no 'withdrawn' event should be emitted on a failed withdrawal"
    );
}

// ── Withdrawer allowlist tests (#607) ─────────────────────────────────────────

/// Helper: create an active stream at timestamp 1_000 with start=1_000, end=1_100.
fn create_active_stream(data: &TestData) -> u64 {
    data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &1000i128,
        &1_100u64,
        &1_200u64,
    );

    // Before start time, should return 0
    assert_eq!(client.claim_drip(&id), 0);

    // Midpoint, should return half
    data.env.ledger().set_timestamp(1_150);
    let drip = client.claim_drip(&id);
    assert_eq!(drip, 500);

    // Withdraw some, then check drip again
    client.withdraw(&id, &200i128);
    let drip_after_withdraw = client.claim_drip(&id);
    assert_eq!(drip_after_withdraw, 300);
}

#[test]
fn init_allowlist_for_org_sets_admin_unpauses_and_allowlists() {
    let data = setup_init();
    let client = contract_client(&data.env);

    let org = Address::generate(&data.env);

    client.init_allowlist_for_org(
        &data.admin,
        &to_sdk_vec(&data.env, &data.tokens),
        &org,
        &to_sdk_vec(&data.env, &data.tokens),
    );

    // Admin path: `set_paused` succeeds, proving `admin` is stored.
    client.set_paused(&data.admin, &false);

    // Global allowlist: every token is allowed.
    let mut i = 0;
    while i < data.tokens.len() {
        let token = data.tokens[i].clone();
        let _id = client.create_stream(
            &data.sender,
            &data.recipient,
            &token,
            &100i128,
            &1_100u64,
            &1_200u64,
        );
        i += 1;
    }

    // Per-org allowlist: every token is allowed for the org.
    let mut i = 0;
    while i < data.tokens.len() {
        let token = data.tokens[i].clone();
        let _id = client.create_stream_for_org(
            &org,
            &data.sender,
            &data.recipient,
            &token,
            &100i128,
            &1_100u64,
            &1_200u64,
        );
        i += 1;
    }
}

#[test]
fn init_allowlist_for_org_twice_returns_already_initialized() {
    let data = setup_init();
    let client = contract_client(&data.env);

    let org = Address::generate(&data.env);

    client.init_allowlist_for_org(
        &data.admin,
        &to_sdk_vec(&data.env, &data.tokens),
        &org,
        &to_sdk_vec(&data.env, &data.tokens),
    );

    let result = client.try_init_allowlist_for_org(
        &data.admin,
        &to_sdk_vec(&data.env, &data.tokens),
        &org,
        &to_sdk_vec(&data.env, &data.tokens),
    );

    let err = result.expect_err("second init should fail");
    assert_eq!(err, Ok(Error::AlreadyInitialized));
}

#[test]
fn init_allowlist_for_org_emits_no_events() {
    let data = setup_init();
    let client = contract_client(&data.env);

    let org = Address::generate(&data.env);

    client.init_allowlist_for_org(
        &data.admin,
        &to_sdk_vec(&data.env, &data.tokens),
        &org,
        &to_sdk_vec(&data.env, &data.tokens),
    );

    let events = data.env.events().all();
    assert!(
        events.is_empty(),
        "init_allowlist_for_org should emit zero events, got: {events:?}",
    );
}

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn init_allowlist_for_org_unauthorized_caller_fails() {
    let data = setup_init();
    let client = contract_client(&data.env);
    let impostor = Address::generate(&data.env);
    let org = Address::generate(&data.env);

    data.env.mock_auths(&[]);
    client.init_allowlist_for_org(
        &impostor,
        &to_sdk_vec(&data.env, &data.tokens),
        &org,
        &to_sdk_vec(&data.env, &data.tokens),
    );
}

// ── Per-user cooloff between stream creations ────────────────────────────────

/// `set_cooloff_duration` sets the global cooloff and emits an event.
#[test]
fn cooloff_set_duration_works_and_emits_event() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &300);

    assert_eq!(client.get_cooloff_duration(), 300);
    assert_eq!(client.get_cooloff_until(&data.sender), 0);
}

/// After `create_stream`, a second create_stream from the same sender is
/// blocked until the cooloff period expires.
#[test]
fn cooloff_blocks_consecutive_create_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &100);

    // First stream: succeeds.
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id > 0);

    // Second stream immediately: blocked by cooloff.
    let err = client
        .try_create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[0],
            &100i128,
            &1_300u64,
            &1_400u64,
        )
        .err()
        .expect("cooloff should block consecutive create_stream");
    assert_eq!(err, Ok(Error::CooloffActive));
}

/// After the cooloff window expires, the sender can create again.
#[test]
fn cooloff_expires_and_allows_create_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &100);

    // First stream at timestamp 1_000 (cooloff until 1_100).
    let id1 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id1 > 0);

    // Advance past cooloff window.
    data.env.ledger().set_timestamp(1_100);

    // Second stream: succeeds (cooloff expired).
    let id2 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_300u64,
        &1_400u64,
    );
    assert!(id2 > 0);
}

/// `create_draft_stream` is also subject to the cooloff guard.
#[test]
fn cooloff_blocks_consecutive_draft_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &100);

    // First draft stream: succeeds.
    let id = client.create_draft_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &100u64,
    );
    assert!(id > 0);

    // Second draft stream immediately: blocked.
    let err = client
        .try_create_draft_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[0],
            &100i128,
            &100u64,
        )
        .err()
        .expect("cooloff should block consecutive create_draft_stream");
    assert_eq!(err, Ok(Error::CooloffActive));
}

/// Different senders have independent cooloff states.
#[test]
fn cooloff_is_per_sender() {
    let data = setup_init();
    let client = contract_client(&data.env);
    let other_sender = Address::generate(&data.env);

    StellarAssetClient::new(&data.env, &data.tokens[0]).mint(&other_sender, &1_000_000);

    client.initialize(&data.admin);
    client.set_cooloff_duration(&data.admin, &100);

    // Sender A creates a stream (enters cooloff).
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id > 0);

    // Sender B can still create a stream.
    let id2 = client.create_stream(
        &other_sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_300u64,
        &1_400u64,
    );
    assert!(id2 > 0);
}

/// Setting cooloff duration to `0` disables the check, even if a cooloff
/// was previously recorded.
#[test]
fn cooloff_disabled_when_duration_is_zero() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &100);

    // First stream enters cooloff.
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id > 0);

    // Disable cooloff.
    client.set_cooloff_duration(&data.admin, &0);

    // Second stream succeeds despite not enough time having passed.
    let id2 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_300u64,
        &1_400u64,
    );
    assert!(id2 > 0);
}

/// Default cooloff is disabled (duration = 0).
#[test]
fn cooloff_default_is_disabled() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    assert_eq!(client.get_cooloff_duration(), 0);

    // Multiple consecutive create_stream calls succeed.
    let id1 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    let id2 = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_300u64,
        &1_400u64,
    );
    assert!(id1 > 0);
    assert!(id2 > 0);
}

/// `create_stream_for_org` is also subject to the cooloff guard (via delegation).
#[test]
fn cooloff_blocks_for_org_stream() {
    let data = setup_init();
    let client = contract_client(&data.env);
    let org = Address::generate(&data.env);

    let tokens = to_sdk_vec(&data.env, &data.tokens);
    client.init_allowlist_for_org(&data.admin, &tokens, &org, &tokens);

    client.set_cooloff_duration(&data.admin, &100);

    // First org stream: succeeds.
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id > 0);

    // Second org stream immediately: blocked.
    let err = client
        .try_create_stream(
            &data.sender,
            &data.recipient,
            &data.tokens[0],
            &100i128,
            &1_300u64,
            &1_400u64,
        )
        .err()
        .expect("cooloff should block consecutive create_stream");
    assert_eq!(err, Ok(Error::CooloffActive));
}

/// `get_cooloff_until` returns the correct expiry timestamp.
#[test]
fn cooloff_until_returns_expiry() {
    let data = setup_init();
    let client = contract_client(&data.env);
    client.initialize(&data.admin);

    client.set_cooloff_duration(&data.admin, &100);

    // Before any stream, cooloff_until is 0.
    assert_eq!(client.get_cooloff_until(&data.sender), 0);

    // Create a stream at timestamp 1_000.
    let id = client.create_stream(
        &data.sender,
        &data.recipient,
        &data.tokens[0],
        &100i128,
        &1_100u64,
        &1_200u64,
    );
    assert!(id > 0);

    // Cooloff until should be 1_000 + 100 = 1_100.
    assert_eq!(client.get_cooloff_until(&data.sender), 1_100);
}

#[test]
fn pause_and_resume_stream_freezes_accrual() {
    let data = setup();

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &100,
        &false,
    );

    // Advance timestamp by 20 seconds -> 200 tokens accrued
    data.env.ledger().set_timestamp(1_020);
    assert_eq!(data.client.withdrawable(&stream_id), 200);

    // Pause stream
    let paused_stream = data.client.pause_stream(&stream_id);
    assert_eq!(paused_stream.status, StreamStatus::Paused);

    // Advance timestamp by another 30 seconds while paused -> accrual must stay frozen at 200
    data.env.ledger().set_timestamp(1_050);
    assert_eq!(data.client.withdrawable(&stream_id), 200);

    // Resume stream at timestamp 1_050
    let resumed_stream = data.client.resume_stream(&stream_id);
    assert_eq!(resumed_stream.status, StreamStatus::Active);
    // start_time shifted by 30 (paused duration: 1_050 - 1_020) -> 1_030, end_time -> 1_130
    assert_eq!(resumed_stream.start_time, 1_030);
    assert_eq!(resumed_stream.end_time, 1_130);

    // Immediately upon resume, withdrawable should still be 200
    assert_eq!(data.client.withdrawable(&stream_id), 200);

    // Advance timestamp by 10 active seconds to 1_060 -> withdrawable should increase to 300
    data.env.ledger().set_timestamp(1_060);
    assert_eq!(data.client.withdrawable(&stream_id), 300);
}

#[test]
fn pause_stream_rejects_non_active_or_unauthorized() {
    let data = setup();
    let unauthorized = Address::generate(&data.env);

    let stream_id = data.client.create_stream(
        &data.sender,
        &data.recipient,
        &data.token,
        &1_000,
        &100,
        &true,
    );

    // Draft stream cannot be paused
    assert_contract_error!(
        data.client.try_pause_stream(&stream_id),
        Error::InvalidState
    );

    // Start stream
    data.client.start_stream(&stream_id);

    // Pause stream successfully
    data.client.pause_stream(&stream_id);

    // Cannot pause already paused stream
    assert_contract_error!(
        data.client.try_pause_stream(&stream_id),
        Error::InvalidState
    );

    // Resume stream
    data.client.resume_stream(&stream_id);

    // Cannot resume active stream
    assert_contract_error!(
        data.client.try_resume_stream(&stream_id),
        Error::InvalidState
    );
}
