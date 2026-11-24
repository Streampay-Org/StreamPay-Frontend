#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Protocol fee tests for multi-recipient split streams (`withdraw_split`).
//!
//! Verifies:
//! - `fee_bps` snapshotted from `default_fee_bps` at split-stream creation
//! - `fee 0` vs `250 bps` vs `10_000 bps`
//! - floor-per-withdrawal rounding (`1`, `3`, `9_999` stroops rounding to zero fee)
//! - multiple recipients with unequal weights withdrawing in pieces
//! - conservation invariant: `collector + recipients + contract == initial_deposit`
//! - no-collector fallback (full gross amount forwarded to recipient, no fee event)
//! - `("stream", "fee")` event emitted strictly when `fee > 0` and collector is set
//! - `get_accumulated_fees(stream_id)` equals the sum of fees charged
//! - settlement drains contract escrow to `0`
//! - `cancel_split_stream` drains contract escrow to `0` (fee-free, matching `cancel_stream`)
//! - property-based test over random weights, deposits, fee rates, and partial withdrawals

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{symbol_short, vec, Address, Env, Symbol, TryFromVal, Vec};
use streampay_stream::{Contract, ContractClient, StreamStatus};

const START_TIME: u64 = 1_000;
const END_TIME: u64 = 2_000;

struct SplitFeeFixture<'a> {
    client: ContractClient<'a>,
    contract_id: Address,
    admin: Address,
    sender: Address,
    collector: Address,
    recipient_a: Address,
    recipient_b: Address,
    token: Address,
}

fn setup<'a>(env: &'a Env, deposit: i128, fee_bps: u32, with_collector: bool) -> SplitFeeFixture<'a> {
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIME);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let sender = Address::generate(env);
    let collector = Address::generate(env);
    let recipient_a = Address::generate(env);
    let recipient_b = Address::generate(env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let asset = StellarAssetClient::new(env, &token);
    asset.mint(&sender, &(deposit * 2));
    asset.mint(&collector, &0);
    asset.mint(&recipient_a, &0);
    asset.mint(&recipient_b, &0);

    client.initialize(&admin);
    if with_collector {
        client.set_fee_collector(&admin, &collector);
    }
    if fee_bps > 0 {
        client.set_default_fee_bps(&admin, &fee_bps);
    }

    SplitFeeFixture {
        client,
        contract_id,
        admin,
        sender,
        collector,
        recipient_a,
        recipient_b,
        token,
    }
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

/// Counts `("stream", "fee")` events published in the current ledger invocation.
fn count_fee_events(env: &Env) -> usize {
    let stream_sym = symbol_short!("stream");
    let fee_sym = symbol_short!("fee");

    let mut count = 0usize;
    for (_contract, topics, _data) in env.events().all().iter() {
        if topics.len() >= 2 {
            let t0 = Symbol::try_from_val(env, &topics.get(0).unwrap()).ok();
            let t1 = Symbol::try_from_val(env, &topics.get(1).unwrap()).ok();
            if t0 == Some(stream_sym.clone()) && t1 == Some(fee_sym.clone()) {
                count += 1;
            }
        }
    }
    count
}

#[test]
fn zero_fee_behaviour_is_unchanged() {
    let env = Env::default();
    let deposit = 10_000i128;
    let fx = setup(&env, deposit, 0, true);

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 1u64, 1u64],
    );

    assert_eq!(fx.client.get_split_stream(&stream_id).fee_bps, 0);

    env.ledger().set_timestamp(END_TIME);
    fx.client.withdraw_split(&stream_id, &fx.recipient_a, &5_000);
    assert_eq!(count_fee_events(&env), 0);

    fx.client.withdraw_split(&stream_id, &fx.recipient_b, &5_000);
    assert_eq!(count_fee_events(&env), 0);

    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 5_000);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_b), 5_000);
    assert_eq!(balance(&env, &fx.token, &fx.collector), 0);
    assert_eq!(balance(&env, &fx.token, &fx.contract_id), 0);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), 0);
    assert_eq!(
        fx.client.get_split_stream(&stream_id).status,
        StreamStatus::Settled
    );
}

#[test]
fn fee_250_bps_splits_net_and_fee_and_drains_escrow() {
    let env = Env::default();
    let deposit = 100_000i128;
    let fx = setup(&env, deposit, 250, true); // 2.5%

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 3u64, 1u64],
    );

    assert_eq!(fx.client.get_split_stream(&stream_id).fee_bps, 250);

    // Changing default_fee_bps after creation must not affect existing split stream.
    fx.client.set_default_fee_bps(&fx.admin, &500);

    // Withdraw in pieces at midpoint (50% vested: A=37_500, B=12_500)
    env.ledger().set_timestamp(START_TIME + 500);
    fx.client
        .withdraw_split(&stream_id, &fx.recipient_a, &20_000);
    assert_eq!(count_fee_events(&env), 1);

    // 20_000 * 250 / 10_000 = 500 fee, 19_500 net
    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 19_500);
    assert_eq!(balance(&env, &fx.token, &fx.collector), 500);
    assert_eq!(
        balance(&env, &fx.token, &fx.collector)
            + balance(&env, &fx.token, &fx.recipient_a)
            + balance(&env, &fx.token, &fx.recipient_b)
            + balance(&env, &fx.token, &fx.contract_id),
        deposit
    );

    // Advance to end and withdraw remaining shares (A=55_000, B=25_000)
    env.ledger().set_timestamp(END_TIME);
    fx.client
        .withdraw_split(&stream_id, &fx.recipient_a, &55_000);
    assert_eq!(count_fee_events(&env), 1);

    fx.client
        .withdraw_split(&stream_id, &fx.recipient_b, &25_000);
    assert_eq!(count_fee_events(&env), 1);

    // Fees: 500 + (55_000 * 250 / 10_000 = 1_375) + (25_000 * 250 / 10_000 = 625) = 2_500
    assert_eq!(balance(&env, &fx.token, &fx.collector), 2_500);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 75_000 - 1_875);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_b), 25_000 - 625);
    assert_eq!(balance(&env, &fx.token, &fx.contract_id), 0);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), 2_500);
    assert_eq!(
        fx.client.get_split_stream(&stream_id).status,
        StreamStatus::Settled
    );
}

#[test]
fn fee_10000_bps_routes_entire_withdrawal_to_collector() {
    let env = Env::default();
    let deposit = 10_000i128;
    let fx = setup(&env, deposit, 10_000, true); // 100%

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 1u64, 1u64],
    );

    env.ledger().set_timestamp(END_TIME);
    fx.client.withdraw_split(&stream_id, &fx.recipient_a, &5_000);
    assert_eq!(count_fee_events(&env), 1);

    fx.client.withdraw_split(&stream_id, &fx.recipient_b, &5_000);
    assert_eq!(count_fee_events(&env), 1);

    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 0);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_b), 0);
    assert_eq!(balance(&env, &fx.token, &fx.collector), deposit);
    assert_eq!(balance(&env, &fx.token, &fx.contract_id), 0);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), deposit);
    assert_eq!(
        fx.client.get_split_stream(&stream_id).status,
        StreamStatus::Settled
    );
}

#[test]
fn floor_rounding_to_zero_fee_for_small_amounts() {
    let env = Env::default();
    // 1 bps = 0.01%: any amount <= 9_999 stroops floors to 0 fee (9_999 * 1 / 10_000 == 0).
    let deposit = 20_000i128;
    let fx = setup(&env, deposit, 1, true);

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 1u64, 1u64],
    );

    env.ledger().set_timestamp(END_TIME);

    // 1 stroop -> fee = floor(1 * 1 / 10_000) = 0
    fx.client.withdraw_split(&stream_id, &fx.recipient_a, &1);
    assert_eq!(count_fee_events(&env), 0);

    // 3 stroops -> fee = floor(3 * 1 / 10_000) = 0
    fx.client.withdraw_split(&stream_id, &fx.recipient_a, &3);
    assert_eq!(count_fee_events(&env), 0);

    // 9_999 stroops -> fee = floor(9_999 * 1 / 10_000) = 0
    fx.client.withdraw_split(&stream_id, &fx.recipient_b, &9_999);
    assert_eq!(count_fee_events(&env), 0);

    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 4);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_b), 9_999);
    assert_eq!(balance(&env, &fx.token, &fx.collector), 0);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), 0);
    assert_eq!(
        balance(&env, &fx.token, &fx.collector)
            + balance(&env, &fx.token, &fx.recipient_a)
            + balance(&env, &fx.token, &fx.recipient_b)
            + balance(&env, &fx.token, &fx.contract_id),
        deposit
    );
}

#[test]
fn no_collector_configured_forwards_fee_to_recipient() {
    let env = Env::default();
    let deposit = 10_000i128;
    let fx = setup(&env, deposit, 250, false); // 2.5% fee, NO collector

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 1u64, 1u64],
    );

    env.ledger().set_timestamp(END_TIME);
    fx.client.withdraw_split(&stream_id, &fx.recipient_a, &5_000);
    assert_eq!(count_fee_events(&env), 0);

    fx.client.withdraw_split(&stream_id, &fx.recipient_b, &5_000);
    assert_eq!(count_fee_events(&env), 0);

    assert_eq!(balance(&env, &fx.token, &fx.recipient_a), 5_000);
    assert_eq!(balance(&env, &fx.token, &fx.recipient_b), 5_000);
    assert_eq!(balance(&env, &fx.token, &fx.collector), 0);
    assert_eq!(balance(&env, &fx.token, &fx.contract_id), 0);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), 0);
    assert_eq!(
        fx.client.get_split_stream(&stream_id).status,
        StreamStatus::Settled
    );
}

#[test]
fn cancel_after_partial_fee_withdrawal_drains_escrow_to_zero() {
    let env = Env::default();
    let deposit = 100_000i128;
    let fx = setup(&env, deposit, 250, true);

    let sender_before = balance(&env, &fx.token, &fx.sender);

    let stream_id = fx.client.create_split_stream(
        &fx.sender,
        &fx.token,
        &deposit,
        &START_TIME,
        &END_TIME,
        &vec![&env, fx.recipient_a.clone(), fx.recipient_b.clone()],
        &vec![&env, 3u64, 1u64],
    );

    // At midpoint: total vested = 50_000 (A = 37_500, B = 12_500)
    env.ledger().set_timestamp(START_TIME + 500);
    fx.client
        .withdraw_split(&stream_id, &fx.recipient_a, &20_000);

    // Cancel at midpoint: A gets remaining 17_500 (fee-free), B gets 12_500 (fee-free),
    // sender gets unvested 50_000.
    fx.client.cancel_split_stream(&stream_id);

    let sender_refund = balance(&env, &fx.token, &fx.sender) - (sender_before - deposit);
    let recip_a = balance(&env, &fx.token, &fx.recipient_a);
    let recip_b = balance(&env, &fx.token, &fx.recipient_b);
    let collector = balance(&env, &fx.token, &fx.collector);
    let contract_bal = balance(&env, &fx.token, &fx.contract_id);

    assert_eq!(collector, 500);
    assert_eq!(fx.client.get_accumulated_fees(&stream_id), 500);
    assert_eq!(contract_bal, 0);
    assert_eq!(recip_a + recip_b + collector + sender_refund, deposit);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Property test: across random weights, deposits, fee rates, and partial
    /// withdrawals, every withdrawal satisfies `net + fee == amount` and
    /// `fee <= amount * fee_bps / 10_000`, `get_accumulated_fees` equals the
    /// collector balance, and total token conservation holds before and after
    /// cancel/settle.
    #[test]
    fn split_fee_invariants_hold(
        weights in prop::collection::vec(1u64..=1_000u64, 2..=4),
        total_amount in 10_000_i128..=500_000_i128,
        fee_bps in 0u32..=10_000u32,
        actions in prop::collection::vec((0u8..=3u8, 1u8..=100u8, 1u8..=100u8), 1..=6),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(START_TIME);

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let collector = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let asset = StellarAssetClient::new(&env, &token);
        asset.mint(&sender, &(total_amount * 2));
        asset.mint(&collector, &0);

        let mut recipients = Vec::new(&env);
        let mut sdk_weights = Vec::new(&env);
        for w in &weights {
            let r = Address::generate(&env);
            asset.mint(&r, &0);
            recipients.push_back(r);
            sdk_weights.push_back(*w);
        }

        let contract_id = env.register(Contract, ());
        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.set_fee_collector(&admin, &collector);
        client.set_default_fee_bps(&admin, &fee_bps);

        let sender_before = balance(&env, &token, &sender);
        let stream_id = client.create_split_stream(
            &sender,
            &token,
            &total_amount,
            &START_TIME,
            &END_TIME,
            &recipients,
            &sdk_weights,
        );

        let mut expected_total_fees = 0i128;

        for (raw_idx, time_pct, amt_pct) in actions {
            let stream = client.get_split_stream(&stream_id);
            if stream.status == StreamStatus::Settled {
                break;
            }

            let target_ts = START_TIME + (END_TIME - START_TIME) * u64::from(time_pct) / 100;
            if target_ts > env.ledger().timestamp() {
                env.ledger().set_timestamp(target_ts);
            }

            let idx = u32::from(raw_idx) % recipients.len();
            let recip = recipients.get(idx).unwrap();
            let avail = client.split_withdrawable(&stream_id, &recip);
            if avail <= 0 {
                continue;
            }

            let amount = (avail * i128::from(amt_pct) / 100).max(1);
            let recip_before = balance(&env, &token, &recip);
            let collector_before = balance(&env, &token, &collector);

            client.withdraw_split(&stream_id, &recip, &amount);

            let net = balance(&env, &token, &recip) - recip_before;
            let fee = balance(&env, &token, &collector) - collector_before;

            prop_assert_eq!(net + fee, amount);
            let expected_fee = amount * i128::from(fee_bps) / 10_000;
            prop_assert_eq!(fee, expected_fee);
            prop_assert!(fee <= expected_fee);

            expected_total_fees += fee;
            prop_assert_eq!(client.get_accumulated_fees(&stream_id), expected_total_fees);

            let mut recip_sum = 0i128;
            for r in recipients.iter() {
                recip_sum += balance(&env, &token, &r);
            }
            let contract_bal = balance(&env, &token, &contract_id);
            let collector_bal = balance(&env, &token, &collector);
            prop_assert_eq!(recip_sum + collector_bal + contract_bal, total_amount);
        }

        // Cancel if not yet settled and verify escrow drains to 0.
        if client.get_split_stream(&stream_id).status != StreamStatus::Settled {
            client.cancel_split_stream(&stream_id);
        }

        let mut recip_sum = 0i128;
        for r in recipients.iter() {
            recip_sum += balance(&env, &token, &r);
        }
        let collector_bal = balance(&env, &token, &collector);
        let sender_refund = balance(&env, &token, &sender) - (sender_before - total_amount);
        let contract_bal = balance(&env, &token, &contract_id);

        prop_assert_eq!(contract_bal, 0);
        prop_assert_eq!(recip_sum + collector_bal + sender_refund, total_amount);
    }
}
