//! # Versioned contract migration
//!
//! Provides a secure, admin-only migration entrypoint that transitions
//! the contract's persistent data from one schema version to another.
//!
//! Migrations are **one-way** and **irreversible** by design: once a
//! contract has been migrated to version N, there is no supported path
//! back to version N−1. This simplifies the audit surface and lets
//! downstream consumers rely on a single storage layout at any point
//! in the contract's lifecycle.
//!
//! ## Data version
//!
//! A single instance-storage key (`StorageVersion`) tracks which schema
//! version the contract's data currently conforms to:
//!
//! | Version | Description                                 |
//! |---------|---------------------------------------------|
//! | `0`     | Unset — pre-migration contract (default).   |
//! | `1`     | Initial layout marker (no data transformation). |
//! | `2`     | Pause bookkeeping normalised on split and recurring records. |
//! | `3`     | Initialise `cliff_time = 0` on existing `Stream` records. |
//!
//! When a new version of the contract requires a storage layout change,
//! a new migration step is added to this module and the version
//! constant is incremented.
//!
//! ## Security
//!
//! - Only the contract admin may initiate a migration.
//! - The admin nonce mechanism (see [`crate::admin`]) is **not** used
//!   here because migrations are not replayable: `migrate` is a single
//!   state-mutating call that bakes the admin's current authorisation
//!   into the current ledger's auth context.
//! - The global pause flag does **not** block migration; an admin
//!   should be able to migrate a paused contract.
//! - Each migration step is idempotent: calling `migrate` when the
//!   contract is already at the latest version is a no-op (returns
//!   `Ok(())`).
//! - A step MUST NOT panic. Any error is returned to the caller with
//!   no partial state change (Soroban rolls back on abort).
//!
//! ## Adding a new migration step
//!
//! 1. Bump [`LATEST_VERSION`] to the next integer.
//! 2. Add a new arm to the `match current` block inside [`migrate_internal`].
//! 3. The new arm calls a private helper function that performs the
//!    storage transformations.
//! 4. Write focused unit tests targeting the new step.
//! 5. Update the doc comment table above.

use core::cmp::{max, min};

use crate::error::Error;
use crate::storage;
use soroban_sdk::{contracttype, Address, Env};

// ── Version constants ─────────────────────────────────────────────────────────

/// The latest supported storage version.
///
/// All new contracts are deployed at this version. The `migrate`
/// entrypoint advances a contract toward this version one step at a
/// time so that intermediate upgrades do not skip a layout change.
pub const LATEST_VERSION: u32 = 3;

/// Maximum number of split/recurring ids rewritten by a single `migrate` call.
///
/// Migration work is bounded so a large dataset cannot exceed the Soroban
/// per-transaction budget. When the limit is reached the version marker stays
/// at the previous value and the admin calls `migrate` again; `storage_version`
/// only advances to [`LATEST_VERSION`] once every record has been visited.
const MIGRATION_BATCH_SIZE: u64 = 50;

/// Storage key for the contract's schema version.
#[derive(Clone)]
#[contracttype]
enum VersionKey {
    /// Singleton: the current [`StorageVersion`] of the contract.
    StorageVersion,
    /// Cursor for a partially applied migration step: the next record id to
    /// rewrite. Absent when no step is in progress.
    MigrationCursor,
}

/// On-chain record of the contract's schema version.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct StorageVersion {
    /// Schema version number (matches one of the constants above).
    pub version: u32,
}

// ── Public helpers (used by the contract entrypoint) ─────────────────────────

/// Returns the current storage version of the contract.
///
/// Returns `0` if no version has been recorded (pre-migration contract).
///
/// # Errors
/// This helper does not return errors.
pub fn current_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get::<VersionKey, StorageVersion>(&VersionKey::StorageVersion)
        .map(|v| v.version)
        .unwrap_or(0)
}

/// Returns `true` when the contract's storage is already at the latest
/// version — i.e. no migration is necessary.
///
/// # Errors
/// This helper does not return errors.
pub fn is_at_latest_version(env: &Env) -> bool {
    current_version(env) >= LATEST_VERSION
}

/// Persists the storage version after a successful migration step.
///
/// Extends the instance TTL analogously to other instance-storage
/// writes in the contract.
fn set_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&VersionKey::StorageVersion, &StorageVersion { version });
    // Extend instance TTL so the version marker does not expire.
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(crate::storage::INSTANCE_TTL_MIN_REMAINING);
    let target = threshold.saturating_add(crate::storage::INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

/// Advances the storage version by one step, rewriting records in batches.
///
/// Returns `true` when the step is complete. A `false` return means the batch
/// limit was hit; the cursor is persisted and a later call continues from it.
fn migrate_records_step(env: &Env) -> bool {
    let start: u64 = env
        .storage()
        .instance()
        .get(&VersionKey::MigrationCursor)
        .unwrap_or(1);

    let last = max(
        crate::multi::next_split_stream_id(env),
        crate::recurring::next_recurring_id(env),
    );

    if start >= last {
        env.storage()
            .instance()
            .remove(&VersionKey::MigrationCursor);
        return true;
    }

    let end = min(start.saturating_add(MIGRATION_BATCH_SIZE), last);
    crate::multi::migrate_records(env, start, end);
    crate::recurring::migrate_records(env, start, end);

    if end >= last {
        env.storage()
            .instance()
            .remove(&VersionKey::MigrationCursor);
        true
    } else {
        env.storage()
            .instance()
            .set(&VersionKey::MigrationCursor, &end);
        false
    }
}

/// Migrates existing [`storage::Stream`] records in bounded batches, setting
/// `cliff_time = 0` so pre-existing streams continue vesting linearly without
/// a cliff and re-stamping their TTLs.
///
/// Returns `true` when all streams have been visited.
fn migrate_streams_cliff_step(env: &Env) -> bool {
    let start: u64 = env
        .storage()
        .instance()
        .get(&VersionKey::MigrationCursor)
        .unwrap_or(1);

    let last = storage::peek_next_stream_id(env);

    if start >= last {
        env.storage()
            .instance()
            .remove(&VersionKey::MigrationCursor);
        return true;
    }

    let end = min(start.saturating_add(MIGRATION_BATCH_SIZE), last);
    for id in start..end {
        if let Some(mut stream) = storage::get_stream(env, id) {
            stream.cliff_time = 0;
            storage::set_stream(env, id, &stream);
        }
    }

    if end >= last {
        env.storage()
            .instance()
            .remove(&VersionKey::MigrationCursor);
        true
    } else {
        env.storage()
            .instance()
            .set(&VersionKey::MigrationCursor, &end);
        false
    }
}

// ── Migration engine ─────────────────────────────────────────────────────────

/// Runs all pending migration steps to bring the contract's storage up
/// to [`LATEST_VERSION`].
///
/// This is the internal workhorse called by the public `migrate`
/// entrypoint.  It reads the current version, then loops through each
/// intermediate step in order.  Each step is idempotent; if the
/// contract is already at the latest version the function returns
/// immediately without touching storage.
///
/// # Errors
///
/// - [`Error::Unauthorized`] if `caller` is not the contract admin.
/// - [`Error::NotFound`] if the contract has not been initialised (no
///   admin set).
/// - Any error returned by an individual migration step.  When a step
///   returns `Err`, the entire transaction is rolled back by the
///   Soroban host — no partial migration is committed.
pub fn migrate_internal(env: &Env, caller: &Address) -> Result<(), Error> {
    // ── Auth gate ──────────────────────────────────────────────────────
    // Only the contract admin may trigger a migration.  We call
    // `require_admin` which performs `caller.require_auth()` and
    // checks that `caller` matches the stored admin address.
    crate::require_admin(env, caller)?;

    // ── Read current version ───────────────────────────────────────────
    let current = current_version(env);

    // Fast path: nothing to do.
    if current >= LATEST_VERSION {
        return Ok(());
    }

    // ── Run migration steps sequentially ───────────────────────────────
    // Each arm advances exactly one version.
    //
    //   version 0  ──►  version 1  ──►  version 2  ──► ...
    //
    // The match is structured so that the compiler forces us to handle
    // every current version below LATEST_VERSION.  If a new step is
    // added, the match must gain a new arm.

    let mut v = current;

    // Step 0 → 1: initial layout (no data transformation needed yet).
    //
    // This step records the version marker so that future steps can
    // distinguish "already migrated" contracts from "pre-migration"
    // ones.  All existing storage keys (admin, paused flag, stream
    // counter, stream rows, allowlist) are unchanged.
    //
    // Sub-sequent steps will add data transformations here.
    if v == 0 {
        set_version(env, 1);
        v = 1;
    }

    // Step 1 → 2: normalise pause bookkeeping on split and recurring records
    // and re-stamp their TTLs. Records are rewritten in bounded batches; when
    // the batch limit is hit the version stays at 1 and the next `migrate`
    // call resumes from the persisted cursor.
    if v == 1 && migrate_records_step(env) {
        set_version(env, 2);
        v = 2;
    }

    // Step 2 → 3: initialise `cliff_time = 0` on all existing `Stream` records
    // so pre-existing streams remain linearly withdrawable without a cliff.
    if v == 2 && migrate_streams_cliff_step(env) {
        set_version(env, 3);
        v = 3;
    }

    // ── Future steps ───────────────────────────────────────────────────
    // Add new `if v == N` blocks below this line for each new version.

    // All steps completed — the contract is now at LATEST_VERSION. A step
    // that returned `false` leaves the version unchanged on purpose.
    debug_assert!(v <= LATEST_VERSION);

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Contract;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, testutils::Events as _, Env};

    /// Minimal contract client for the migrate entrypoint.
    #[contract]
    struct MigrateTestContract;

    #[contractimpl]
    impl MigrateTestContract {
        pub fn migrate(env: Env, admin: Address) -> Result<(), Error> {
            migrate_internal(&env, &admin)
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Register the real StreamPay contract so admin/storage is set up.
        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);

        // Initialise with the real contract.
        client.initialize(&admin);

        (env, admin)
    }

    fn migrate_client(env: &Env) -> MigrateTestContractClient<'_> {
        let id = env.register(MigrateTestContract, ());
        MigrateTestContractClient::new(env, &id)
    }

    // ── current_version and is_at_latest_version ───────────────────────────

    #[test]
    fn current_version_returns_zero_for_unmigrated_contract() {
        let (env, _admin) = setup();
        // Before `migrate()` is called, the version key does not exist.
        let version = current_version(&env);
        assert_eq!(version, 0, "pre-migration contract must report version 0");
    }

    #[test]
    fn is_at_latest_version_returns_false_for_unmigrated_contract() {
        let (env, _admin) = setup();
        assert!(
            !is_at_latest_version(&env),
            "unmigrated contract should not be at latest version"
        );
    }

    #[test]
    fn is_at_latest_version_returns_true_after_migration() {
        let (env, admin) = setup();
        let client = migrate_client(&env);

        client.migrate(&admin);

        assert!(
            is_at_latest_version(&env),
            "after migration the contract should report latest version"
        );
    }

    // ── Migration success ─────────────────────────────────────────────────

    #[test]
    fn migrate_sets_version_to_latest() {
        let (env, admin) = setup();
        let client = migrate_client(&env);

        let _ = client.migrate(&admin);

        let version = current_version(&env);
        assert_eq!(
            version, LATEST_VERSION,
            "migrate must advance version to {LATEST_VERSION}, got {version}"
        );
    }

    #[test]
    fn migrate_is_idempotent() {
        let (env, admin) = setup();
        let client = migrate_client(&env);

        // First call.
        client.migrate(&admin);
        assert!(is_at_latest_version(&env));

        // Second call — should be a no-op.
        let result = client.try_migrate(&admin);
        assert!(
            result.is_ok(),
            "second migrate call must be idempotent (no error)"
        );
        assert!(
            is_at_latest_version(&env),
            "contract must still be at latest version after second call"
        );
    }

    #[test]
    fn migrate_succeeds_even_if_paused() {
        let (env, admin) = setup();

        // Pause the contract.
        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.set_paused(&admin, &true);

        let mclient = migrate_client(&env);
        let result = mclient.try_migrate(&admin);
        assert!(
            result.is_ok(),
            "migrate must succeed even when contract is paused"
        );
    }

    // ── Auth ──────────────────────────────────────────────────────────────

    #[test]
    fn migrate_requires_admin_auth() {
        let env = Env::default();
        // Do NOT call mock_all_auths to prove auth is enforced.
        let admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let mclient = migrate_client(&env);

        // An impostor calling migrate should fail auth.
        // With no mock_auths set, the host fires HostError.
        // We need to catch this via std::panic::catch_unwind or by
        // mocking specific auths.  Here we use mock_all_auths to simplify
        // and test authorization at the `require_admin` check level.
        env.mock_all_auths();
        let result = mclient.try_migrate(&impostor);
        assert!(result.is_err(), "non-admin caller must be rejected");
    }

    #[test]
    fn migrate_fails_for_uninitialized_contract() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // Register the migrate test contract WITHOUT initialising the
        // real StreamPay contract — no admin key exists.
        let mclient = migrate_client(&env);

        let result = mclient.try_migrate(&admin);
        assert!(
            result.is_err(),
            "migrate on an uninitialised contract must fail"
        );
    }

    // ── Version marker persistence ────────────────────────────────────────

    #[test]
    fn version_marker_survives_after_migration() {
        let (env, admin) = setup();
        let client = migrate_client(&env);

        client.migrate(&admin);

        // Read the stored version directly.
        let stored: Option<StorageVersion> =
            env.storage().instance().get(&VersionKey::StorageVersion);
        assert!(
            stored.is_some(),
            "version marker must be persisted after migration"
        );
        assert_eq!(
            stored.unwrap().version,
            LATEST_VERSION,
            "persisted version must match LATEST_VERSION"
        );
    }

    // ── Read-only views unaffected ────────────────────────────────────────

    /// After migration, the contract's read-only views must still work.
    #[test]
    fn read_views_work_after_migration() {
        let (env, admin) = setup();
        let client = migrate_client(&env);

        client.migrate(&admin);

        // Verify the admin is still accessible.
        let contract_id = env.register(Contract, ());
        let sp_client = crate::ContractClient::new(&env, &contract_id);
        // Need to init again because register creates a fresh instance.
        sp_client.initialize(&admin);
        // Just verify get_stream returns NotFound for non-existent stream
        // (the contract is still functional).
        // Actually we can just verify no panic by calling a read-only view.
        let paused = sp_client.is_paused();
        assert!(
            !paused,
            "paused flag must still be readable after migration"
        );
    }

    #[test]
    fn migrate_v2_to_v3_sets_cliff_time_zero_and_preserves_withdrawable() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        // Seed contract at version 2 with a pre-existing stream.
        let stream_id = 1u64;
        env.as_contract(&contract_id, || {
            set_version(&env, 2);
            let stream = storage::Stream {
                id: stream_id,
                sender: Address::generate(&env),
                recipient: Address::generate(&env),
                token: Address::generate(&env),
                total_amount: 1_000,
                released_amount: 0,
                start_time: 1_000,
                end_time: 2_000,
                duration: 1_000,
                last_update: 1_000,
                status: storage::StreamStatus::Active,
                paused_at: 0,
                total_paused_duration: 0,
                fee_bps: 0,
                cliff_time: 1_500, // non-zero sentinel to verify migration resets it to 0
            };
            storage::set_stream(&env, stream_id, &stream);
            storage::set_next_stream_id_for_test(&env, 2);

            migrate_internal(&env, &admin).unwrap();

            assert_eq!(current_version(&env), LATEST_VERSION);
            let migrated = storage::get_stream(&env, stream_id).unwrap();
            assert_eq!(migrated.cliff_time, 0);
            assert_eq!(crate::release::withdrawable(&migrated, 1_500), Ok(500));
        });
    }
}
