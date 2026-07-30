#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Property-based tests for StreamPay contract state invariants.
//!
//! These tests exercise the public contract API and verify that withdrawals
//! preserve the stream's accounting state across generated valid inputs.

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient, StreamStatus};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Withdrawing any valid portion of the currently withdrawable amount must:
    ///
    /// - increase `released_amount` by exactly the withdrawn amount;
    /// - never make `released_amount` exceed `total_amount`;
    /// - reduce `withdrawable` by exactly the withdrawn amount;
    /// - preserve the stream's original total amount.
    #[test]
    fn withdrawal_preserves_stream_accounting(
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2_u64..=10_000_u64,
        elapsed_percent in 1_u64..=100_u64,
        withdraw_percent in 1_i128..=100_i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        StellarAssetClient::new(&env, &token)
            .mint(&sender, &(total_amount * 2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);

        client.initialize(&admin);

        let start_time = 1_100_u64;
        let end_time = start_time + duration;

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token,
            &total_amount,
            &start_time,
            &end_time,
        );

        let elapsed = ((duration * elapsed_percent) / 100).max(1);
        env.ledger()
            .set_timestamp(start_time + elapsed.min(duration));

        let stream_before = client.get_stream(&stream_id);
        let withdrawable_before = client.withdrawable(&stream_id);

        prop_assume!(withdrawable_before > 0);

        let withdraw_amount =
            ((withdrawable_before * withdraw_percent) / 100).max(1);

        client.withdraw(&recipient, &stream_id, &withdraw_amount);

        let stream_after = client.get_stream(&stream_id);
        let withdrawable_after = client.withdrawable(&stream_id);

        prop_assert_eq!(
            stream_after.released_amount,
            stream_before.released_amount + withdraw_amount
        );

        prop_assert!(stream_after.released_amount <= total_amount);
        prop_assert_eq!(stream_after.total_amount, total_amount);

        prop_assert_eq!(
            withdrawable_after + withdraw_amount,
            withdrawable_before
        );

    }

    /// Withdrawing the full vested balance at the end of a stream must settle
    /// it without changing the original total amount.
    #[test]
    fn full_withdrawal_at_end_settles_stream(
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2_u64..=10_000_u64,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        StellarAssetClient::new(&env, &token)
            .mint(&sender, &(total_amount * 2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);

        client.initialize(&admin);

        let start_time = 1_100_u64;
        let end_time = start_time + duration;

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token,
            &total_amount,
            &start_time,
            &end_time,
        );

        env.ledger().set_timestamp(end_time);

        let withdrawable = client.withdrawable(&stream_id);
        prop_assert_eq!(withdrawable, total_amount);

        client.withdraw(&recipient, &stream_id, &withdrawable);

        let stream = client.get_stream(&stream_id);

        prop_assert_eq!(stream.total_amount, total_amount);
        prop_assert_eq!(stream.released_amount, total_amount);
        prop_assert_eq!(stream.status, StreamStatus::Settled);
        prop_assert_eq!(client.withdrawable(&stream_id), 0);
    }

    /// A partial withdrawal followed by withdrawal of the remaining balance
    /// at the stream end must settle without losing or creating value.
    #[test]
    fn partial_then_final_withdrawal_settles_exactly(
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2_u64..=10_000_u64,
        first_withdraw_percent in 1_i128..=99_i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        StellarAssetClient::new(&env, &token)
            .mint(&sender, &(total_amount * 2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);

        client.initialize(&admin);

        let start_time = 1_100_u64;
        let end_time = start_time + duration;

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token,
            &total_amount,
            &start_time,
            &end_time,
        );

        env.ledger().set_timestamp(start_time + duration / 2);

        let first_available = client.withdrawable(&stream_id);
        prop_assume!(first_available > 0);

        let first_withdrawal =
            ((first_available * first_withdraw_percent) / 100).max(1);

        client.withdraw(&recipient, &stream_id, &first_withdrawal);

        env.ledger().set_timestamp(end_time);

        let remaining = client.withdrawable(&stream_id);
        client.withdraw(&recipient, &stream_id, &remaining);

        let final_stream = client.get_stream(&stream_id);

        prop_assert_eq!(final_stream.released_amount, total_amount);
        prop_assert_eq!(final_stream.total_amount, total_amount);
        prop_assert_eq!(final_stream.status, StreamStatus::Settled);
        prop_assert_eq!(client.withdrawable(&stream_id), 0);
    }

}
