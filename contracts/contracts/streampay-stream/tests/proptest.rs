#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Property-based tests for StreamPay contract state invariants.
//!
//! These tests exercise the public contract API and verify that withdrawals
//! preserve the stream's accounting state across generated valid inputs.

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, Vec};
use streampay_stream::{Contract, ContractClient, Milestone, StreamStatus};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

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

    /// Milestone streams vest monotonically, stay bounded by `total_amount`,
    /// and vest `total_amount` at `end_time`.
    #[test]
    fn milestone_stream_monotonic_and_full_at_end(
        total_amount in 10_000_i128..=1_000_000_i128,
        d1 in 1_u64..=5_000_u64,
        d2 in 1_u64..=5_000_u64,
        bps1 in 0_u32..=10_000_u32,
        probe1 in 0_u64..=10_000_u64,
        delta in 0_u64..=5_000_u64,
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
        let m1_time = start_time + d1;
        let end_time = m1_time + d2;

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            time: m1_time,
            cumulative_bps: bps1,
        });
        milestones.push_back(Milestone {
            time: end_time,
            cumulative_bps: 10_000,
        });

        let stream_id = client.create_stream_with_milestones(
            &sender,
            &recipient,
            &token,
            &total_amount,
            &start_time,
            &end_time,
            &0u32,
            &milestones,
        );

        let t1 = start_time + probe1;
        let t2 = t1 + delta;

        env.ledger().set_timestamp(t1);
        let w1 = client.withdrawable(&stream_id);

        env.ledger().set_timestamp(t2);
        let w2 = client.withdrawable(&stream_id);

        env.ledger().set_timestamp(end_time);
        let w_end = client.withdrawable(&stream_id);

        prop_assert!(w1 >= 0 && w1 <= total_amount);
        prop_assert!(w2 >= 0 && w2 <= total_amount);
        prop_assert!(w1 <= w2);
        prop_assert_eq!(w_end, total_amount);
    }

    /// Recurring stream vesting is non-decreasing over time and never exceeds
    /// the maximum vested amount (amount_per_cycle * total_cycles).
    /// Test bounds: amount_per_cycle in [1_000, 100_000_000],
    /// cycle_duration in [1, 10_000], total_cycles in [1, 50].
    #[test]
    fn recurring_vested_is_monotonic_and_bounded(
        amount_per_cycle in 1_000_i128..=100_000_000_i128,
        cycle_duration in 1_u64..=10_000_u64,
        total_cycles in 1_u64..=50_u64,
        timestamps in prop::collection::vec(0_u64..=1_000_000_u64, 2..=20),
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

        let total_escrow = amount_per_cycle.saturating_mul(i128::from(total_cycles));
        StellarAssetClient::new(&env, &token)
            .mint(&sender, &total_escrow.saturating_mul(2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let start_time = 100_000_u64;
        let recurring_id = client.create_recurring_stream(
            &sender,
            &recipient,
            &token,
            &amount_per_cycle,
            &cycle_duration,
            &total_cycles,
            &start_time,
            &0u32,
        ).unwrap();

        let mut sorted_timestamps = timestamps;
        sorted_timestamps.sort();

        let mut prev_vested = 0i128;
        for &ts in &sorted_timestamps {
            env.ledger().set_timestamp(ts);
            let vested = client.recurring_vested(&recurring_id).unwrap();

            prop_assert!(vested >= prev_vested, "vested decreased: {} > {}", prev_vested, vested);
            prop_assert!(vested <= amount_per_cycle.saturating_mul(i128::from(total_cycles)),
                         "vested {} exceeds max {}", vested, amount_per_cycle.saturating_mul(i128::from(total_cycles)));

            prev_vested = vested;
        }
    }

    /// Recurring withdrawable is always <= vested and >= 0, including after
    /// interleaved partial withdrawals.
    /// Test bounds: amount_per_cycle in [1_000, 100_000_000],
    /// cycle_duration in [1, 10_000], total_cycles in [1, 50].
    #[test]
    fn recurring_withdrawable_bounded_by_vested(
        amount_per_cycle in 1_000_i128..=100_000_000_i128,
        cycle_duration in 1_u64..=10_000_u64,
        total_cycles in 1_u64..=50_u64,
        timestamps in prop::collection::vec(0_u64..=1_000_000_u64, 2..=20),
        withdraw_percents in prop::collection::vec(1_i128..=100_i128, 1..=5),
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

        let total_escrow = amount_per_cycle.saturating_mul(i128::from(total_cycles));
        StellarAssetClient::new(&env, &token)
            .mint(&sender, &total_escrow.saturating_mul(2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let start_time = 100_000_u64;
        let recurring_id = client.create_recurring_stream(
            &sender,
            &recipient,
            &token,
            &amount_per_cycle,
            &cycle_duration,
            &total_cycles,
            &start_time,
            &0u32,
        ).unwrap();

        let mut sorted_timestamps = timestamps;
        sorted_timestamps.sort();
        let mut withdraw_iter = withdraw_percents.iter().cycle();

        for (idx, &ts) in sorted_timestamps.iter().enumerate() {
            env.ledger().set_timestamp(ts);

            let vested = client.recurring_vested(&recurring_id).unwrap();
            let withdrawable = client.recurring_withdrawable(&recurring_id).unwrap();

            prop_assert!(withdrawable <= vested, "withdrawable {} > vested {}", withdrawable, vested);
            prop_assert!(withdrawable >= 0, "withdrawable {} < 0", withdrawable);

            if withdrawable > 0 && idx % 3 == 0 {
                let percent = withdraw_iter.next().copied().unwrap_or(50);
                let withdraw_amount = ((withdrawable * percent) / 100).max(1).min(withdrawable);

                if withdraw_amount > 0 {
                    client.withdraw_recurring(&recipient, &recurring_id, &withdraw_amount).unwrap();
                }
            }

            let vested_after = client.recurring_vested(&recurring_id).unwrap();
            let withdrawable_after = client.recurring_withdrawable(&recurring_id).unwrap();

            prop_assert!(withdrawable_after <= vested_after, 
                         "after withdrawal: withdrawable {} > vested {}", withdrawable_after, vested_after);
            prop_assert!(withdrawable_after >= 0, "after withdrawal: withdrawable {} < 0", withdrawable_after);
        }
    }

    /// Calling process_recurring_stream never makes cycles_completed go backwards
    /// or exceed total_cycles.
    /// Test bounds: amount_per_cycle in [1_000, 100_000_000],
    /// cycle_duration in [1, 10_000], total_cycles in [1, 50].
    #[test]
    fn recurring_process_never_regresses_or_exceeds(
        amount_per_cycle in 1_000_i128..=100_000_000_i128,
        cycle_duration in 1_u64..=10_000_u64,
        total_cycles in 1_u64..=50_u64,
        timestamps in prop::collection::vec(0_u64..=1_000_000_u64, 2..=15),
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

        let total_escrow = amount_per_cycle.saturating_mul(i128::from(total_cycles));
        StellarAssetClient::new(&env, &token)
            .mint(&sender, &total_escrow.saturating_mul(2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let start_time = 100_000_u64;
        let recurring_id = client.create_recurring_stream(
            &sender,
            &recipient,
            &token,
            &amount_per_cycle,
            &cycle_duration,
            &total_cycles,
            &start_time,
            &0u32,
        ).unwrap();

        let mut sorted_timestamps = timestamps;
        sorted_timestamps.sort();

        let mut prev_cycles = 0u64;
        for &ts in &sorted_timestamps {
            env.ledger().set_timestamp(ts);
            let stream = client.process_recurring_stream(&recurring_id).unwrap();

            prop_assert!(stream.cycles_completed >= prev_cycles,
                         "cycles_completed regressed: {} < {}", stream.cycles_completed, prev_cycles);
            prop_assert!(stream.cycles_completed <= total_cycles,
                         "cycles_completed {} exceeds total_cycles {}", stream.cycles_completed, total_cycles);

            prev_cycles = stream.cycles_completed;
        }
    }

    /// Before start_time, recurring_vested is exactly 0.
    /// Test bounds: amount_per_cycle in [1_000, 100_000_000],
    /// cycle_duration in [1, 10_000], total_cycles in [1, 50].
    #[test]
    fn recurring_vested_is_zero_before_start_time(
        amount_per_cycle in 1_000_i128..=100_000_000_i128,
        cycle_duration in 1_u64..=10_000_u64,
        total_cycles in 1_u64..=50_u64,
        time_before_start in 1_u64..=100_000_u64,
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

        let total_escrow = amount_per_cycle.saturating_mul(i128::from(total_cycles));
        StellarAssetClient::new(&env, &token)
            .mint(&sender, &total_escrow.saturating_mul(2));

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let start_time = 200_000_u64;
        let recurring_id = client.create_recurring_stream(
            &sender,
            &recipient,
            &token,
            &amount_per_cycle,
            &cycle_duration,
            &total_cycles,
            &start_time,
            &0u32,
        ).unwrap();

        let check_time = start_time.saturating_sub(time_before_start);
        env.ledger().set_timestamp(check_time);

        let vested = client.recurring_vested(&recurring_id).unwrap();
        prop_assert_eq!(vested, 0, "vested {} != 0 at time {} (before start {})", vested, check_time, start_time);

        let withdrawable = client.recurring_withdrawable(&recurring_id).unwrap();
        prop_assert_eq!(withdrawable, 0, "withdrawable {} != 0 before start_time", withdrawable);
    }

}
