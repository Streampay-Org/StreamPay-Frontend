//! Integration tests for the version-2 storage migration.
//!
//! `migrate` normalises pause bookkeeping on split and recurring records and
//! advances `storage_version()` from 0/1 to 2. Records are rewritten in
//! bounded batches; when the batch limit is hit the version stays at 1 until
//! the admin calls `migrate` again.

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, vec, Address, Env};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;

struct MigrationTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient_a: Address,
    recipient_b: Address,
    token: Address,
    client: ContractClient<'static>,
}

fn setup() -> MigrationTestData {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIME);

    let contract_id = env.register(Contract, ());
    let client: ContractClient<'static> =
        unsafe { core::mem::transmute(ContractClient::new(&env, &contract_id)) };

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let recipient_b = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);
    StellarAssetClient::new(&env, &token).mint(&recipient_a, &0);
    StellarAssetClient::new(&env, &token).mint(&recipient_b, &0);

    client.initialize(&admin);

    MigrationTestData {
        env,
        admin,
        sender,
        recipient_a,
        recipient_b,
        token,
        client,
    }
}

fn create_split(data: &MigrationTestData) -> u64 {
    data.client.create_split_stream(
        &data.sender,
        &data.token,
        &1_000,
        &START_TIME,
        &END_TIME,
        &vec![
            &data.env,
            data.recipient_a.clone(),
            data.recipient_b.clone(),
        ],
        &vec![&data.env, 1u64, 1u64],
    )
}

fn create_recurring(data: &MigrationTestData) -> u64 {
    data.client.create_recurring_stream(
        &data.sender,
        &data.recipient_a,
        &data.token,
        &100,
        &100,
        &10,
        &START_TIME,
        &0,
    )
}

#[test]
fn migrate_without_records_sets_version_two() {
    let data = setup();

    assert_eq!(data.client.storage_version(), 0);
    data.client.migrate(&data.admin);
    assert_eq!(data.client.storage_version(), 2);
}

#[test]
fn migrate_preserves_split_and_recurring_records() {
    let data = setup();
    let split_id = create_split(&data);
    let recurring_id = create_recurring(&data);

    data.env.ledger().set_timestamp(1_400);
    let split_withdrawable = data.client.split_withdrawable(&split_id, &data.recipient_a);
    let recurring_withdrawable = data.client.recurring_withdrawable(&recurring_id);

    data.client.migrate(&data.admin);
    assert_eq!(data.client.storage_version(), 2);

    let split = data.client.get_split_stream(&split_id);
    assert_eq!(split.id, split_id);
    assert_eq!(split.total_amount, 1_000);
    assert_eq!(split.start_time, START_TIME);
    assert_eq!(split.end_time, END_TIME);
    assert_eq!(split.status, StreamStatus::Active);
    assert_eq!(split.pause_time, 0);
    assert_eq!(split.total_paused_duration, 0);
    assert_eq!(split.recipients.len(), 2);
    assert_eq!(
        data.client.split_withdrawable(&split_id, &data.recipient_a),
        split_withdrawable
    );

    let recurring = data.client.get_recurring_stream(&recurring_id);
    assert_eq!(recurring.id, recurring_id);
    assert_eq!(recurring.amount_per_cycle, 100);
    assert_eq!(recurring.total_cycles, 10);
    assert_eq!(recurring.cycles_completed, 0);
    assert_eq!(recurring.withdrawn_amount, 0);
    assert_eq!(recurring.status, StreamStatus::Active);
    assert_eq!(recurring.paused_at, 0);
    assert_eq!(recurring.total_paused_duration, 0);
    assert_eq!(
        data.client.recurring_withdrawable(&recurring_id),
        recurring_withdrawable
    );
}

#[test]
fn migrate_is_idempotent() {
    let data = setup();
    let split_id = create_split(&data);

    data.client.migrate(&data.admin);
    assert_eq!(data.client.storage_version(), 2);

    let result = data.client.try_migrate(&data.admin);
    assert!(result.is_ok(), "second migrate call must succeed");
    assert_eq!(data.client.storage_version(), 2);
    assert_eq!(data.client.get_split_stream(&split_id).id, split_id);
}

#[test]
fn non_admin_cannot_migrate() {
    let data = setup();
    let impostor = Address::generate(&data.env);

    let result = data.client.try_migrate(&impostor);
    let err = result.expect_err("non-admin caller must be rejected");
    assert_eq!(err, Ok(Error::Unauthorized));
    assert_eq!(data.client.storage_version(), 0);
}

#[test]
fn paused_split_stream_survives_migration() {
    let data = setup();
    let split_id = create_split(&data);

    data.env.ledger().set_timestamp(1_500);
    data.client.pause_split_stream(&split_id);
    let frozen = data.client.split_withdrawable(&split_id, &data.recipient_a);

    data.env.ledger().set_timestamp(1_800);
    data.client.migrate(&data.admin);

    let split = data.client.get_split_stream(&split_id);
    assert_eq!(split.status, StreamStatus::Paused);
    assert_eq!(split.pause_time, 1_500);
    assert_eq!(
        data.client.split_withdrawable(&split_id, &data.recipient_a),
        frozen
    );
}

#[test]
fn migrate_processes_records_in_batches() {
    let data = setup();
    // The batch limit is 50 ids per call, so 51 records need two calls.
    let mut i = 0;
    while i < 51 {
        create_recurring(&data);
        i += 1;
    }

    data.client.migrate(&data.admin);
    assert_eq!(
        data.client.storage_version(),
        1,
        "a partially applied batch must not advance the version"
    );

    data.client.migrate(&data.admin);
    assert_eq!(data.client.storage_version(), 2);
}
