#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{symbol_short, Address, Env, IntoVal, Vec};
use streampay_stream::{
    Contract, ContractClient, Error, StreamStatus, WithdrawOutcome, MAX_WITHDRAW_MANY_BATCH,
};

struct TestEnv {
    env: Env,
    contract_id: Address,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
}

impl TestEnv {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let contract_id = env.register(Contract, ());
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token = token_contract.address();

        StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000i128);

        let client = ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        Self {
            env,
            contract_id,
            admin,
            sender,
            recipient,
            token,
        }
    }

    fn client(&self) -> ContractClient<'_> {
        ContractClient::new(&self.env, &self.contract_id)
    }

    fn token_client(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    fn create_active_stream(
        &self,
        recipient: &Address,
        amount: i128,
        start: u64,
        end: u64,
        fee_bps: u32,
    ) -> u64 {
        self.client().create_stream(
            &self.sender,
            recipient,
            &self.token,
            &amount,
            &start,
            &end,
            &fee_bps,
        )
    }
}

#[test]
fn withdraw_many_matches_individual_withdraws_with_fees_and_events() {
    let t = TestEnv::new();
    let client = t.client();
    let collector = Address::generate(&t.env);
    client.set_fee_collector(&t.admin, &collector);

    // Stream 1: partial withdrawal at t=1500, 100 bps (1%) fee -> 500 gross, 5 fee, 495 net
    let s1 = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 100);
    // Stream 2: full withdrawal (settles) at t=1500, 500 bps (5%) fee -> 2_000 gross, 100 fee, 1_900 net
    let s2 = t.create_active_stream(&t.recipient, 2_000, 1_000, 1_500, 500);
    // Stream 3: partial withdrawal at t=1500, 0 bps fee -> 300 gross, 0 fee, 300 net
    let s3 = t.create_active_stream(&t.recipient, 600, 1_000, 2_000, 0);

    t.env.ledger().set_timestamp(1_500);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s1);
    ids.push_back(s2);
    ids.push_back(s3);

    let outcomes = client.withdraw_many(&t.recipient, &ids);
    assert_eq!(outcomes.len(), 3);
    assert_eq!(
        outcomes.get(0).unwrap(),
        WithdrawOutcome {
            stream_id: s1,
            amount: 500,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(1).unwrap(),
        WithdrawOutcome {
            stream_id: s2,
            amount: 2_000,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(2).unwrap(),
        WithdrawOutcome {
            stream_id: s3,
            amount: 300,
            error: None,
        }
    );

    // Total tokens moved and fee amounts equal the sum of equivalent individual withdraws:
    // Recipient net = 495 + 1_900 + 300 = 2_695
    // Collector fee = 5 + 100 + 0 = 105
    assert_eq!(t.token_client().balance(&t.recipient), 2_695);
    assert_eq!(t.token_client().balance(&collector), 105);

    // Stream 2 should be settled; streams 1 and 3 remain active.
    assert_eq!(client.get_stream(&s1).status, StreamStatus::Active);
    assert_eq!(client.get_stream(&s2).status, StreamStatus::Settled);
    assert_eq!(client.get_stream(&s3).status, StreamStatus::Active);

    // Verify events emitted: 3 withdrawn, 1 settled (s2), 2 fee_charged (s1, s2).
    let events = t.env.events().all();
    let mut withdrawn_count = 0u32;
    let mut settled_count = 0u32;
    let mut fee_count = 0u32;

    for (_addr, topics, _data) in events.iter() {
        if topics.len() == 2 {
            let t0 = topics.get(0).unwrap();
            let t1 = topics.get(1).unwrap();
            if t0 == symbol_short!("stream").into_val(&t.env) {
                if t1 == symbol_short!("withdrawn").into_val(&t.env) {
                    withdrawn_count += 1;
                } else if t1 == symbol_short!("settled").into_val(&t.env) {
                    settled_count += 1;
                } else if t1 == symbol_short!("fee").into_val(&t.env) {
                    fee_count += 1;
                }
            }
        }
    }

    assert_eq!(withdrawn_count, 3);
    assert_eq!(settled_count, 1);
    assert_eq!(fee_count, 2);

    // Caller auth was required once for the batch.
    assert_eq!(t.env.auths().len(), 1);
    assert_eq!(t.env.auths()[0].0, t.recipient);
}

#[test]
fn withdraw_many_empty_list_succeeds() {
    let t = TestEnv::new();
    let client = t.client();

    let ids: Vec<u64> = Vec::new(&t.env);
    let outcomes = client.withdraw_many(&t.recipient, &ids);
    assert_eq!(outcomes.len(), 0);
}

#[test]
fn withdraw_many_over_limit_returns_invalid_amount() {
    let t = TestEnv::new();
    let client = t.client();

    let mut ids = Vec::new(&t.env);
    for i in 1..=(MAX_WITHDRAW_MANY_BATCH + 1) {
        ids.push_back(u64::from(i));
    }

    let res = client.try_withdraw_many(&t.recipient, &ids);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn withdraw_many_duplicate_ids_are_deterministic() {
    let t = TestEnv::new();
    let client = t.client();

    // Stream 1: partial at t=1500 (500 withdrawable, remains Active)
    let s1 = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 0);
    // Stream 2: full at t=1500 (1000 withdrawable, becomes Settled)
    let s2 = t.create_active_stream(&t.recipient, 1_000, 1_000, 1_500, 0);

    t.env.ledger().set_timestamp(1_500);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s1);
    ids.push_back(s1);
    ids.push_back(s2);
    ids.push_back(s2);

    let outcomes = client.withdraw_many(&t.recipient, &ids);
    assert_eq!(outcomes.len(), 4);

    assert_eq!(
        outcomes.get(0).unwrap(),
        WithdrawOutcome {
            stream_id: s1,
            amount: 500,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(1).unwrap(),
        WithdrawOutcome {
            stream_id: s1,
            amount: 0,
            error: Some(Error::InvalidAmount as u32),
        }
    );
    assert_eq!(
        outcomes.get(2).unwrap(),
        WithdrawOutcome {
            stream_id: s2,
            amount: 1_000,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(3).unwrap(),
        WithdrawOutcome {
            stream_id: s2,
            amount: 0,
            error: Some(Error::AlreadySettled as u32),
        }
    );

    assert_eq!(t.token_client().balance(&t.recipient), 1_500);
}

#[test]
fn withdraw_many_mixed_recipients_and_missing_id_do_not_rollback() {
    let t = TestEnv::new();
    let client = t.client();
    let other_recipient = Address::generate(&t.env);

    let s_mine_1 = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 0);
    let s_other = t.create_active_stream(&other_recipient, 1_000, 1_000, 2_000, 0);
    let s_mine_2 = t.create_active_stream(&t.recipient, 800, 1_000, 2_000, 0);

    t.env.ledger().set_timestamp(1_500);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s_mine_1);
    ids.push_back(s_other);
    ids.push_back(999_999);
    ids.push_back(s_mine_2);

    let outcomes = client.withdraw_many(&t.recipient, &ids);
    assert_eq!(outcomes.len(), 4);

    assert_eq!(
        outcomes.get(0).unwrap(),
        WithdrawOutcome {
            stream_id: s_mine_1,
            amount: 500,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(1).unwrap(),
        WithdrawOutcome {
            stream_id: s_other,
            amount: 0,
            error: Some(Error::Unauthorized as u32),
        }
    );
    assert_eq!(
        outcomes.get(2).unwrap(),
        WithdrawOutcome {
            stream_id: 999_999,
            amount: 0,
            error: Some(Error::NotFound as u32),
        }
    );
    assert_eq!(
        outcomes.get(3).unwrap(),
        WithdrawOutcome {
            stream_id: s_mine_2,
            amount: 400,
            error: None,
        }
    );

    assert_eq!(t.token_client().balance(&t.recipient), 900);
    assert_eq!(t.token_client().balance(&other_recipient), 0);
}

#[test]
fn withdraw_many_aborts_when_contract_paused() {
    let t = TestEnv::new();
    let client = t.client();

    let s1 = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 0);
    t.env.ledger().set_timestamp(1_500);

    client.set_paused(&t.admin, &true);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s1);

    let res = client.try_withdraw_many(&t.recipient, &ids);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(t.token_client().balance(&t.recipient), 0);
}

#[test]
fn withdraw_many_allowlisted_withdrawer_succeeds() {
    let t = TestEnv::new();
    let client = t.client();
    let delegate = Address::generate(&t.env);

    let s_allowed = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 0);
    let s_denied = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 0);

    client.add_withdrawer(&s_allowed, &delegate);
    t.env.ledger().set_timestamp(1_500);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s_allowed);
    ids.push_back(s_denied);

    let outcomes = client.withdraw_many(&delegate, &ids);
    assert_eq!(outcomes.len(), 2);
    assert_eq!(
        outcomes.get(0).unwrap(),
        WithdrawOutcome {
            stream_id: s_allowed,
            amount: 500,
            error: None,
        }
    );
    assert_eq!(
        outcomes.get(1).unwrap(),
        WithdrawOutcome {
            stream_id: s_denied,
            amount: 0,
            error: Some(Error::Unauthorized as u32),
        }
    );

    // Funds go to the stream recipient, not the delegate.
    assert_eq!(t.token_client().balance(&t.recipient), 500);
    assert_eq!(t.token_client().balance(&delegate), 0);
}

#[test]
fn withdraw_many_fee_collector_unset_forwards_full_amount_to_recipient() {
    let t = TestEnv::new();
    let client = t.client();

    // Non-zero fee_bps, but no fee collector configured.
    let s1 = t.create_active_stream(&t.recipient, 1_000, 1_000, 2_000, 500);
    let s2 = t.create_active_stream(&t.recipient, 2_000, 1_000, 2_000, 250);

    t.env.ledger().set_timestamp(1_500);

    let mut ids = Vec::new(&t.env);
    ids.push_back(s1);
    ids.push_back(s2);

    let outcomes = client.withdraw_many(&t.recipient, &ids);
    assert_eq!(outcomes.len(), 2);
    assert_eq!(outcomes.get(0).unwrap().amount, 500);
    assert_eq!(outcomes.get(1).unwrap().amount, 1_000);

    // Full gross amount reaches recipient when collector is unset.
    assert_eq!(t.token_client().balance(&t.recipient), 1_500);

    // No fee_charged event should be emitted.
    let events = t.env.events().all();
    for (_addr, topics, _data) in events.iter() {
        if topics.len() == 2
            && topics.get(0).unwrap() == symbol_short!("stream").into_val(&t.env)
        {
            assert_ne!(
                topics.get(1).unwrap(),
                symbol_short!("fee").into_val(&t.env)
            );
        }
    }
}
