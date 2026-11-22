#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

use crate::{Contract, ContractClient, Error};

fn setup() -> (Env, Address, ContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);
    (env, contract_id, client)
}

fn create_token<'a>(
    env: &'a Env,
    recipient_to_mint: &Address,
    amount: i128,
) -> (Address, token::Client<'a>) {
    let token_admin = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let sac = token::StellarAssetClient::new(env, &token_addr);
    sac.mint(recipient_to_mint, &amount);
    let client = token::Client::new(env, &token_addr);
    (token_addr, client)
}

#[test]
fn set_and_clear_max_stream_amount_requires_admin() {
    let (env, _contract_id, client) = setup();
    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize(&admin);
    assert_eq!(client.max_stream_amount(&token), None);

    // Non-admin cannot set cap.
    let err = client
        .try_set_max_stream_amount(&non_admin, &token, &1_000)
        .expect_err("non-admin should be rejected");
    assert_eq!(err, Ok(Error::Unauthorized));
    assert_eq!(client.max_stream_amount(&token), None);

    // Admin can set cap.
    client.set_max_stream_amount(&admin, &token, &1_000);
    assert_eq!(client.max_stream_amount(&token), Some(1_000));

    // Non-admin cannot clear cap.
    let err = client
        .try_clear_max_stream_amount(&non_admin, &token)
        .expect_err("non-admin should be rejected");
    assert_eq!(err, Ok(Error::Unauthorized));
    assert_eq!(client.max_stream_amount(&token), Some(1_000));

    // Admin can clear cap.
    client.clear_max_stream_amount(&admin, &token);
    assert_eq!(client.max_stream_amount(&token), None);
}

#[test]
fn set_max_stream_amount_rejects_non_positive() {
    let (env, _contract_id, client) = setup();
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize(&admin);

    let err_zero = client
        .try_set_max_stream_amount(&admin, &token, &0)
        .expect_err("zero cap should fail");
    assert_eq!(err_zero, Ok(Error::InvalidAmount));

    let err_neg = client
        .try_set_max_stream_amount(&admin, &token, &-50)
        .expect_err("negative cap should fail");
    assert_eq!(err_neg, Ok(Error::InvalidAmount));

    assert_eq!(client.max_stream_amount(&token), None);
}

#[test]
fn create_stream_enforces_cap_boundary_without_moving_funds() {
    let (env, contract_id, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_client) = create_token(&env, &sender, 10_000);

    client.initialize(&admin);
    env.ledger().set_timestamp(1_000);

    let cap = 1_000i128;
    client.set_max_stream_amount(&admin, &token, &cap);

    // Amount == cap succeeds.
    let id = client.create_stream(&sender, &recipient, &token, &cap, &1_000, &2_000, &0);
    assert!(id > 0);
    assert_eq!(token_client.balance(&sender), 9_000);
    assert_eq!(token_client.balance(&contract_id), 1_000);

    // Amount == cap + 1 fails with AmountTooLarge and no funds move.
    let err = client
        .try_create_stream(&sender, &recipient, &token, &(cap + 1), &1_000, &2_000, &0)
        .expect_err("amount above cap should fail");
    assert_eq!(err, Ok(Error::AmountTooLarge));
    assert_eq!(token_client.balance(&sender), 9_000);
    assert_eq!(token_client.balance(&contract_id), 1_000);
}

#[test]
fn max_stream_amount_is_isolated_per_token() {
    let (env, _contract_id, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token_a, _) = create_token(&env, &sender, 10_000);
    let (token_b, _) = create_token(&env, &sender, 10_000);

    client.initialize(&admin);
    env.ledger().set_timestamp(1_000);

    client.set_max_stream_amount(&admin, &token_a, &500);
    assert_eq!(client.max_stream_amount(&token_a), Some(500));
    assert_eq!(client.max_stream_amount(&token_b), None);

    // Token A rejects 501.
    let err = client
        .try_create_stream(&sender, &recipient, &token_a, &501, &1_000, &2_000, &0)
        .expect_err("token A above cap should fail");
    assert_eq!(err, Ok(Error::AmountTooLarge));

    // Token B has no cap and accepts 5_000.
    let id_b = client.create_stream(&sender, &recipient, &token_b, &5_000, &1_000, &2_000, &0);
    assert!(id_b > 0);
}

#[test]
fn unset_or_cleared_cap_allows_unlimited_amounts() {
    let (env, _contract_id, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, _) = create_token(&env, &sender, 100_000);

    client.initialize(&admin);
    env.ledger().set_timestamp(1_000);

    // Unset cap allows large amount.
    let id1 = client.create_stream(&sender, &recipient, &token, &10_000, &1_000, &2_000, &0);
    assert!(id1 > 0);

    // Setting cap blocks 10_000.
    client.set_max_stream_amount(&admin, &token, &5_000);
    let err = client
        .try_create_stream(&sender, &recipient, &token, &10_000, &1_000, &2_000, &0)
        .expect_err("amount above cap should fail");
    assert_eq!(err, Ok(Error::AmountTooLarge));

    // Clearing cap restores unlimited behavior.
    client.clear_max_stream_amount(&admin, &token);
    assert_eq!(client.max_stream_amount(&token), None);
    let id2 = client.create_stream(&sender, &recipient, &token, &10_000, &1_000, &2_000, &0);
    assert!(id2 > id1);
}

#[test]
fn create_draft_stream_enforces_cap_without_moving_funds() {
    let (env, contract_id, client) = setup();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_client) = create_token(&env, &sender, 10_000);

    client.initialize(&admin);
    env.ledger().set_timestamp(1_000);

    let cap = 2_000i128;
    client.set_max_stream_amount(&admin, &token, &cap);

    // Draft == cap succeeds.
    let id = client.create_draft_stream(&sender, &recipient, &token, &cap, &500);
    assert!(id > 0);
    assert_eq!(token_client.balance(&sender), 8_000);
    assert_eq!(token_client.balance(&contract_id), 2_000);

    // Draft == cap + 1 fails with AmountTooLarge and no funds move.
    let err = client
        .try_create_draft_stream(&sender, &recipient, &token, &(cap + 1), &500)
        .expect_err("draft amount above cap should fail");
    assert_eq!(err, Ok(Error::AmountTooLarge));
    assert_eq!(token_client.balance(&sender), 8_000);
    assert_eq!(token_client.balance(&contract_id), 2_000);
}

#[test]
fn create_stream_for_org_enforces_cap_without_moving_funds() {
    let (env, contract_id, client) = setup();
    let admin = Address::generate(&env);
    let org = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (token, token_client) = create_token(&env, &sender, 10_000);

    client.initialize(&admin);
    env.ledger().set_timestamp(1_000);

    let cap = 1_500i128;
    client.set_max_stream_amount(&admin, &token, &cap);

    // Org stream == cap succeeds.
    let id =
        client.create_stream_for_org(&org, &sender, &recipient, &token, &cap, &1_000, &2_000, &0);
    assert!(id > 0);
    assert_eq!(token_client.balance(&sender), 8_500);
    assert_eq!(token_client.balance(&contract_id), 1_500);

    // Org stream == cap + 1 fails with AmountTooLarge and no funds move.
    let err = client
        .try_create_stream_for_org(
            &org,
            &sender,
            &recipient,
            &token,
            &(cap + 1),
            &1_000,
            &2_000,
            &0,
        )
        .expect_err("org stream amount above cap should fail");
    assert_eq!(err, Ok(Error::AmountTooLarge));
    assert_eq!(token_client.balance(&sender), 8_500);
    assert_eq!(token_client.balance(&contract_id), 1_500);
}
