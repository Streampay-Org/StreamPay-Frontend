#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, Address, Env, IntoVal, TryFromVal,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

fn setup() -> (Env, ContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);
    (env, client)
}

fn create_token<'a>(
    env: &'a Env,
    admin: &'a Address,
    mint_to: &'a Address,
    amount: i128,
) -> (Address, token::Client<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let stellar_client = token::StellarAssetClient::new(env, &token_addr);
    stellar_client.mint(mint_to, &amount);
    let token_client = token::Client::new(env, &token_addr);
    (token_addr, token_client)
}

#[test]
fn dormancy_grace_default_is_zero_and_admin_can_set() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let other = Address::generate(&env);

    client.initialize(&admin);
    assert_eq!(client.get_dormancy_grace(), 0);

    // Non-admin cannot set dormancy grace.
    let err = client.try_set_dormancy_grace(&other, &3600).unwrap_err();
    assert_eq!(err, Ok(Error::Unauthorized));

    // Admin can set dormancy grace and an event is emitted.
    env.ledger().with_mut(|li| li.timestamp = 500);
    client.set_dormancy_grace(&admin, &3600);
    assert_eq!(client.get_dormancy_grace(), 3600);

    let events = env.events().all();
    assert!(!events.is_empty());
    let last = events.last().unwrap();
    let topic0 = soroban_sdk::Symbol::try_from_val(&env, &last.1.get(0).unwrap()).unwrap();
    let topic1 = soroban_sdk::Symbol::try_from_val(&env, &last.1.get(1).unwrap()).unwrap();
    assert_eq!(topic0, symbol_short!("stream"));
    assert_eq!(topic1, symbol_short!("dorm_grc"));
}

#[test]
fn sweep_dormant_stream_disabled_returns_dormancy_disabled() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, _) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    env.ledger().with_mut(|li| li.timestamp = 10_000);
    let err = client.try_sweep_dormant_stream(&id).unwrap_err();
    assert_eq!(err, Ok(Error::DormancyDisabled));
}

#[test]
fn sweep_dormant_stream_success_at_exact_boundary() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, tkn) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &500);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    let sender_before = tkn.balance(&sender);
    assert_eq!(sender_before, 0);

    // Exactly at end_time + grace = 200 + 500 = 700.
    env.ledger().with_mut(|li| li.timestamp = 700);
    let swept = client.sweep_dormant_stream(&id);
    assert_eq!(swept, 1_000);
    assert_eq!(tkn.balance(&sender), 1_000);
    assert_eq!(tkn.balance(&recipient), 0);

    let stream = client.get_stream(&id);
    assert_eq!(stream.status, StreamStatus::Settled);
    assert_eq!(stream.released_amount, 1_000);

    // Verify dormant_swept event was emitted.
    let events = env.events().all();
    let last = events.last().unwrap();
    let topic0 = soroban_sdk::Symbol::try_from_val(&env, &last.1.get(0).unwrap()).unwrap();
    let topic1 = soroban_sdk::Symbol::try_from_val(&env, &last.1.get(1).unwrap()).unwrap();
    assert_eq!(topic0, symbol_short!("stream"));
    assert_eq!(topic1, symbol_short!("dorm_swp"));
}

#[test]
fn sweep_dormant_stream_too_early_and_boundary_withdraw_succeeds() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, tkn) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &500);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    // Before end_time.
    env.ledger().with_mut(|li| li.timestamp = 150);
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::NotDormant)
    );

    // At end_time + grace - 1 = 699 -> sweep must fail, recipient withdraw must succeed.
    env.ledger().with_mut(|li| li.timestamp = 699);
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::NotDormant)
    );

    let withdrawn = client.withdraw(&recipient, &id, &1_000);
    assert_eq!(withdrawn, 1_000);
    assert_eq!(tkn.balance(&recipient), 1_000);
    assert_eq!(client.get_stream(&id).status, StreamStatus::Settled);
}

#[test]
fn recipient_withdraw_and_second_sweep_after_sweep_fail_cleanly() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, _) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &100);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    env.ledger().with_mut(|li| li.timestamp = 300);
    assert_eq!(client.sweep_dormant_stream(&id), 1_000);

    // Recipient withdrawal after sweep fails cleanly with AlreadySettled.
    assert_eq!(
        client.try_withdraw(&recipient, &id, &1).unwrap_err(),
        Ok(Error::AlreadySettled)
    );

    // Second sweep fails cleanly with AlreadySettled.
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::AlreadySettled)
    );
}

#[test]
fn sweep_dormant_stream_requires_sender_auth() {
    let env = Env::default();
    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    let (token, _) = create_token(&env, &admin, &sender, 1_000);
    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &100);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    env.ledger().with_mut(|li| li.timestamp = 500);

    // Authorize only attacker (not sender) -> must fail auth.
    let res = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "sweep_dormant_stream",
                args: (id,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_sweep_dormant_stream(&id);
    assert!(res.is_err());
}

#[test]
fn sweep_dormant_stream_rejected_when_globally_paused() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, _) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &100);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    client.set_paused(&admin, &true);
    env.ledger().with_mut(|li| li.timestamp = 500);

    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::ContractPaused)
    );
}

#[test]
fn repeated_withdraw_resets_dormancy_clock() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, tkn) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &500);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    // Recipient withdraws 200 at t = 600 (> end_time).
    // Dormancy deadline shifts from 200 + 500 = 700 to 600 + 500 = 1100.
    env.ledger().with_mut(|li| li.timestamp = 600);
    assert_eq!(client.withdraw(&recipient, &id, &200), 200);

    // At t = 700 (old deadline), sweep must fail.
    env.ledger().with_mut(|li| li.timestamp = 700);
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::NotDormant)
    );

    // At t = 1099 (new deadline - 1), sweep must still fail.
    env.ledger().with_mut(|li| li.timestamp = 1099);
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::NotDormant)
    );

    // At t = 1100 (new deadline), sweep succeeds for remaining 800.
    env.ledger().with_mut(|li| li.timestamp = 1100);
    assert_eq!(client.sweep_dormant_stream(&id), 800);
    assert_eq!(tkn.balance(&recipient), 200);
    assert_eq!(tkn.balance(&sender), 800);
}

#[test]
fn sweep_dormant_stream_with_fees_and_collector_conserves_tokens() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let collector = Address::generate(&env);
    let (token, tkn) = create_token(&env, &admin, &sender, 10_000);

    client.initialize(&admin);
    client.set_fee_collector(&admin, &collector);
    client.set_dormancy_grace(&admin, &300);

    // 250 bps = 2.5% fee.
    let id = client.create_stream(&sender, &recipient, &token, &10_000, &100, &200, &250);

    // Partial withdraw of 4_000 at t = 250: fee = 100, net = 3_900.
    env.ledger().with_mut(|li| li.timestamp = 250);
    assert_eq!(client.withdraw(&recipient, &id, &4_000), 4_000);

    // Sweep remaining 6_000 at t = 250 + 300 = 550: fee = 150, net = 5_850.
    env.ledger().with_mut(|li| li.timestamp = 550);
    assert_eq!(client.sweep_dormant_stream(&id), 6_000);

    let r_bal = tkn.balance(&recipient);
    let s_bal = tkn.balance(&sender);
    let c_bal = tkn.balance(&collector);
    assert_eq!(r_bal, 3_900);
    assert_eq!(s_bal, 5_850);
    assert_eq!(c_bal, 250);
    assert_eq!(r_bal + s_bal + c_bal, 10_000);
}

#[test]
fn sweep_dormant_stream_with_fees_but_no_collector_returns_full_amount() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, tkn) = create_token(&env, &admin, &sender, 10_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &300);

    // 500 bps fee configured on stream, but no collector set.
    let id = client.create_stream(&sender, &recipient, &token, &10_000, &100, &200, &500);

    env.ledger().with_mut(|li| li.timestamp = 500);
    assert_eq!(client.sweep_dormant_stream(&id), 10_000);
    assert_eq!(tkn.balance(&sender), 10_000);
    assert_eq!(tkn.balance(&recipient), 0);
}

#[test]
fn sweep_dormant_stream_overflow_grace_returns_not_dormant() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, _) = create_token(&env, &admin, &sender, 1_000);

    client.initialize(&admin);
    client.set_dormancy_grace(&admin, &u64::MAX);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100, &200, &0);

    env.ledger().with_mut(|li| li.timestamp = u64::MAX);
    assert_eq!(
        client.try_sweep_dormant_stream(&id).unwrap_err(),
        Ok(Error::NotDormant)
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn prop_token_conservation_across_withdraw_and_dormant_sweep(
        total_amount in 100i128..1_000_000_000i128,
        partial_pct in 0u32..100u32,
        fee_bps in 0u32..=10_000u32,
        has_collector in any::<bool>(),
        grace in 1u64..100_000u64,
    ) {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let collector = Address::generate(&env);
        let (token, tkn) = create_token(&env, &admin, &sender, total_amount);

        client.initialize(&admin);
        if has_collector {
            client.set_fee_collector(&admin, &collector);
        }
        client.set_dormancy_grace(&admin, &grace);

        let start = 1_000u64;
        let end = 2_000u64;
        let id = client.create_stream(&sender, &recipient, &token, &total_amount, &start, &end, &fee_bps);

        let partial_amount = (total_amount * i128::from(partial_pct)) / 100;
        let mut last_withdraw = 0u64;
        if partial_amount > 0 && partial_amount < total_amount {
            let withdraw_ts = end + 10;
            env.ledger().with_mut(|li| li.timestamp = withdraw_ts);
            client.withdraw(&recipient, &id, &partial_amount);
            last_withdraw = withdraw_ts;
        }

        let reference = core::cmp::max(end, last_withdraw);
        env.ledger().with_mut(|li| li.timestamp = reference + grace);
        client.sweep_dormant_stream(&id);

        let total_paid = tkn.balance(&recipient) + tkn.balance(&sender) + tkn.balance(&collector);
        prop_assert!(total_paid <= total_amount);
        prop_assert_eq!(total_paid, total_amount);
    }
}
