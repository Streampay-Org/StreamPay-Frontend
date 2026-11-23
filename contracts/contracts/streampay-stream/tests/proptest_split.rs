#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Property-based tests for multi-recipient ("split") stream accounting.
//!
//! All assertions go through the public [`ContractClient`]; no private module
//! is touched. The properties mirror the split logic in `src/multi.rs`:
//! `create_split_stream`, `withdraw_split`, `split_withdrawable` and the
//! per-recipient vesting in `recipient_vested`.
//!
//! Rounding dust
//! ─────────────
//! `recipient_vested` computes `floor(total_vested * weight / total_weight)`
//! per recipient, so at `end_time` the per-recipient shares can sum to less
//! than `total_amount` by up to `recipients.len() - 1` base units. The stream
//! only settles when `total_released == total_amount` exactly, so a stream
//! with dust stays `Active` after every recipient withdraws its full share.
//! `cancel_split_stream` refunds that dust to the sender. The property tests
//! below assert this behaviour instead of hiding it.

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, Vec};
use streampay_stream::{Contract, ContractClient, Error, SplitStream, StreamStatus};

const START_TIME: u64 = 1_100;

struct Fixture<'a> {
    client: ContractClient<'a>,
    token: Address,
    sender: Address,
    recipients: Vec<Address>,
    stream_id: u64,
    weights: std::vec::Vec<u64>,
    total_weight: u64,
    end_time: u64,
}

fn setup<'a>(env: &'a Env, total_amount: i128, weights: &[u64], duration: u64) -> Fixture<'a> {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(env);
    let sender = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    StellarAssetClient::new(env, &token).mint(&sender, &(total_amount * 2));

    let mut recipients = Vec::new(env);
    let mut sdk_weights = Vec::new(env);
    let mut total_weight = 0u64;
    for weight in weights {
        recipients.push_back(Address::generate(env));
        sdk_weights.push_back(*weight);
        total_weight += *weight;
    }

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(env, &contract_id);
    client.initialize(&admin);

    let end_time = START_TIME + duration;
    let stream_id = client.create_split_stream(
        &sender,
        &token,
        &total_amount,
        &START_TIME,
        &end_time,
        &recipients,
        &sdk_weights,
    );

    Fixture {
        client,
        token,
        sender,
        recipients,
        stream_id,
        weights: weights.to_vec(),
        total_weight,
        end_time,
    }
}

fn released_sum(stream: &SplitStream) -> i128 {
    let mut sum = 0i128;
    for alloc in stream.recipients.iter() {
        sum += alloc.released_amount;
    }
    sum
}

fn expected_share(total_amount: i128, weight: u64, total_weight: u64) -> i128 {
    total_amount * i128::from(weight) / i128::from(total_weight)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Properties 1 and 2: after every successful withdrawal the sum of
    /// per-recipient `released_amount` equals `total_released`, never exceeds
    /// `total_amount`, and no recipient ever releases more than its weighted
    /// share of `total_amount`. `split_withdrawable` never goes negative.
    #[test]
    fn withdrawals_preserve_split_allocation_sums(
        weights in prop::collection::vec(1u64..=10_000u64, 2..=6),
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2u64..=10_000u64,
        actions in prop::collection::vec(
            (0u8..=5u8, 0u8..=100u8, 1u8..=100u8),
            0..=8,
        ),
    ) {
        let env = Env::default();
        let fx = setup(&env, total_amount, &weights, duration);

        for (raw_index, time_percent, amount_percent) in actions {
            let stream = fx.client.get_split_stream(&fx.stream_id);
            if stream.status == StreamStatus::Settled {
                break;
            }

            let index = u32::from(raw_index) % fx.recipients.len();
            let recipient = fx.recipients.get(index).unwrap();

            let offset = duration * u64::from(time_percent) / 100;
            let now = (START_TIME + offset).max(env.ledger().timestamp());
            env.ledger().set_timestamp(now);

            let withdrawable = fx.client.split_withdrawable(&fx.stream_id, &recipient);
            prop_assert!(withdrawable >= 0);
            if withdrawable == 0 {
                continue;
            }

            let mut amount = withdrawable * i128::from(amount_percent) / 100;
            if amount < 1 {
                amount = 1;
            }
            if amount > withdrawable {
                amount = withdrawable;
            }

            fx.client.withdraw_split(&fx.stream_id, &recipient, &amount);

            let after = fx.client.get_split_stream(&fx.stream_id);
            prop_assert_eq!(released_sum(&after), after.total_released);
            prop_assert!(after.total_released <= total_amount);

            for (i, alloc) in after.recipients.iter().enumerate() {
                let weight = fx.weights[i as usize];
                prop_assert!(
                    alloc.released_amount
                        <= expected_share(total_amount, weight, fx.total_weight)
                );
                prop_assert!(
                    fx.client.split_withdrawable(&fx.stream_id, &alloc.recipient) >= 0
                );
            }
        }
    }

    /// Property 3: withdrawing more than `split_withdrawable` fails with
    /// `OverWithdraw` and leaves the stream state untouched.
    #[test]
    fn over_withdraw_is_rejected_without_state_change(
        weights in prop::collection::vec(1u64..=10_000u64, 2..=6),
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2u64..=10_000u64,
        raw_index in 0u8..=5u8,
        time_percent in 0u8..=100u8,
        over_by in 1_i128..=10_000_i128,
    ) {
        let env = Env::default();
        let fx = setup(&env, total_amount, &weights, duration);

        let index = u32::from(raw_index) % fx.recipients.len();
        let recipient = fx.recipients.get(index).unwrap();

        let offset = duration * u64::from(time_percent) / 100;
        env.ledger().set_timestamp(START_TIME + offset);

        let before = fx.client.get_split_stream(&fx.stream_id);
        let withdrawable = fx.client.split_withdrawable(&fx.stream_id, &recipient);

        let result = fx
            .client
            .try_withdraw_split(&fx.stream_id, &recipient, &(withdrawable + over_by));
        prop_assert!(matches!(result, Err(Ok(Error::OverWithdraw))));

        let after = fx.client.get_split_stream(&fx.stream_id);
        prop_assert_eq!(after.total_released, before.total_released);
        prop_assert_eq!(after.status, before.status);
        for (i, alloc) in after.recipients.iter().enumerate() {
            let before_alloc = before.recipients.get(i as u32).unwrap();
            prop_assert_eq!(alloc.released_amount, before_alloc.released_amount);
        }
    }

    /// Property 4: at `end_time` every recipient can withdraw its full share.
    /// When the shares sum to `total_amount` the stream settles; when integer
    /// division leaves dust the stream stays `Active` and cancelling refunds
    /// the dust to the sender (nothing is stranded).
    #[test]
    fn full_withdrawal_at_end_releases_total_minus_dust(
        weights in prop::collection::vec(1u64..=10_000u64, 2..=6),
        total_amount in 10_000_i128..=1_000_000_i128,
        duration in 2u64..=10_000u64,
    ) {
        let env = Env::default();
        let fx = setup(&env, total_amount, &weights, duration);

        env.ledger().set_timestamp(fx.end_time);

        let stream = fx.client.get_split_stream(&fx.stream_id);
        let mut expected_released = 0i128;

        for alloc in stream.recipients.iter() {
            let share = expected_share(total_amount, alloc.weight, fx.total_weight);
            let withdrawable = fx.client.split_withdrawable(&fx.stream_id, &alloc.recipient);
            prop_assert_eq!(withdrawable, share - alloc.released_amount);

            if withdrawable > 0 {
                fx.client
                    .withdraw_split(&fx.stream_id, &alloc.recipient, &withdrawable);
            }
            expected_released += share;
        }

        let dust = total_amount - expected_released;
        prop_assert!(dust >= 0);
        prop_assert!(dust < i128::from(stream.recipients.len()));

        let final_stream = fx.client.get_split_stream(&fx.stream_id);
        prop_assert_eq!(final_stream.total_released, expected_released);
        prop_assert_eq!(released_sum(&final_stream), expected_released);

        if dust == 0 {
            prop_assert_eq!(final_stream.status, StreamStatus::Settled);
        } else {
            // Rounding dust keeps the stream open; the contract only settles on
            // an exact `total_released == total_amount`.
            prop_assert_eq!(final_stream.status, StreamStatus::Active);

            let token = TokenClient::new(&env, &fx.token);
            let sender_before = token.balance(&fx.sender);
            fx.client.cancel_split_stream(&fx.stream_id);
            let sender_after = token.balance(&fx.sender);

            prop_assert_eq!(sender_after - sender_before, dust);
        }
    }
}

/// Minimal reproducer for the rounding-dust behaviour: 100 base units split
/// equally across 3 recipients yields 33 each (99 released), so the stream
/// stays `Active` after every recipient withdraws its full share.
#[test]
fn equal_split_rounding_dust_is_documented() {
    let env = Env::default();
    let fx = setup(&env, 100, &[1, 1, 1], 100);

    env.ledger().set_timestamp(fx.end_time);

    let recipients: std::vec::Vec<Address> = fx
        .client
        .get_split_stream(&fx.stream_id)
        .recipients
        .iter()
        .map(|alloc| alloc.recipient.clone())
        .collect();

    for recipient in recipients {
        let withdrawable = fx.client.split_withdrawable(&fx.stream_id, &recipient);
        assert_eq!(withdrawable, 33);
        fx.client
            .withdraw_split(&fx.stream_id, &recipient, &withdrawable);
    }

    let stream = fx.client.get_split_stream(&fx.stream_id);
    assert_eq!(stream.total_released, 99);
    assert_eq!(stream.status, StreamStatus::Active);
}

/// When the weighted shares divide the total exactly, withdrawing at
/// `end_time` settles the stream with no dust left behind.
#[test]
fn divisible_split_settles_at_end() {
    let env = Env::default();
    let fx = setup(&env, 100, &[1, 1], 100);

    env.ledger().set_timestamp(fx.end_time);

    let recipients: std::vec::Vec<Address> = fx
        .client
        .get_split_stream(&fx.stream_id)
        .recipients
        .iter()
        .map(|alloc| alloc.recipient.clone())
        .collect();

    for recipient in recipients {
        let withdrawable = fx.client.split_withdrawable(&fx.stream_id, &recipient);
        assert_eq!(withdrawable, 50);
        fx.client
            .withdraw_split(&fx.stream_id, &recipient, &withdrawable);
    }

    let stream = fx.client.get_split_stream(&fx.stream_id);
    assert_eq!(stream.total_released, 100);
    assert_eq!(stream.status, StreamStatus::Settled);
}
