//! # Two-step recipient transfer integration tests
//!
//! Verifies `propose_recipient_transfer`, `accept_recipient_transfer`,
//! `cancel_recipient_transfer`, and `get_pending_recipient` across happy paths,
//! authorization boundaries, listing views, withdrawer allowlist clearing,
//! events, and edge cases.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

struct Fixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
    contract_id: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    StellarAssetClient::new(&env, &token).mint(&sender, &10_000_000);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    Fixture {
        env,
        admin,
        sender,
        recipient,
        token,
        contract_id,
    }
}

fn create_active_stream(f: &Fixture, total: i128, start: u64, end: u64, fee_bps: u32) -> u64 {
    let client = ContractClient::new(&f.env, &f.contract_id);
    client.create_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &total,
        &start,
        &end,
        &fee_bps,
    )
}

#[test]
fn happy_path_propose_accept_withdraw_and_released_preserved() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let token = TokenClient::new(&f.env, &f.token);
    let new_recipient = Address::generate(&f.env);

    // Active stream: 1000 tokens over [1100, 2100]
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);

    // Advance to midpoint (t = 1600): 500 vested. Old recipient withdraws 300.
    f.env.ledger().set_timestamp(1_600);
    client.withdraw(&f.recipient, &id, &300);
    assert_eq!(token.balance(&f.recipient), 300);
    assert_eq!(client.get_stream(&id).released_amount, 300);

    // Propose transfer to new_recipient
    client.propose_recipient_transfer(&id, &new_recipient);
    assert_eq!(
        client.get_pending_recipient(&id),
        Some(new_recipient.clone())
    );
    // Stream recipient has NOT changed yet
    assert_eq!(client.get_stream(&id).recipient, f.recipient);

    // Accept transfer
    client.accept_recipient_transfer(&id);
    assert_eq!(client.get_pending_recipient(&id), None);
    let stream = client.get_stream(&id);
    assert_eq!(stream.recipient, new_recipient);
    // Already-released funds stay released
    assert_eq!(stream.released_amount, 300);

    // Old recipient can no longer withdraw
    let old_res = client.try_withdraw(&f.recipient, &id, &100);
    assert_eq!(old_res, Err(Ok(Error::Unauthorized)));

    // New recipient can withdraw remaining vested (200 at t=1600)
    client.withdraw(&new_recipient, &id, &200);
    assert_eq!(token.balance(&new_recipient), 200);
    assert_eq!(token.balance(&f.recipient), 300);
    assert_eq!(client.get_stream(&id).released_amount, 500);
}

#[test]
fn wrong_signer_rejected_for_propose_accept_and_cancel() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let new_recipient = Address::generate(&f.env);
    let outsider = Address::generate(&f.env);

    // 1. Propose with wrong signer (sender instead of recipient) fails auth
    f.env.mock_auths(&[MockAuth {
        address: &f.sender,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_recipient_transfer",
            args: (id, new_recipient.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client
        .try_propose_recipient_transfer(&id, &new_recipient)
        .is_err());

    // Propose properly with mock_all_auths
    f.env.mock_all_auths();
    client.propose_recipient_transfer(&id, &new_recipient);

    // 2. Accept with wrong signer (old recipient instead of new_recipient) fails auth
    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "accept_recipient_transfer",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_accept_recipient_transfer(&id).is_err());

    // 3. Cancel with outsider returns Unauthorized
    f.env.mock_all_auths();
    let cancel_res = client.try_cancel_recipient_transfer(&id, &outsider);
    assert_eq!(cancel_res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn accept_without_proposal_returns_no_pending_transfer() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);

    let res = client.try_accept_recipient_transfer(&id);
    assert_eq!(res, Err(Ok(Error::NoPendingTransfer)));
}

#[test]
fn cancel_without_proposal_returns_no_pending_transfer() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);

    let res = client.try_cancel_recipient_transfer(&id, &f.recipient);
    assert_eq!(res, Err(Ok(Error::NoPendingTransfer)));
}

#[test]
fn overwrite_proposal_replaces_pending_recipient() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let candidate_b = Address::generate(&f.env);
    let candidate_c = Address::generate(&f.env);

    client.propose_recipient_transfer(&id, &candidate_b);
    assert_eq!(client.get_pending_recipient(&id), Some(candidate_b.clone()));

    // Overwrite with candidate_c
    client.propose_recipient_transfer(&id, &candidate_c);
    assert_eq!(client.get_pending_recipient(&id), Some(candidate_c.clone()));

    // candidate_b can no longer accept
    f.env.mock_auths(&[MockAuth {
        address: &candidate_b,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "accept_recipient_transfer",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_accept_recipient_transfer(&id).is_err());

    // candidate_c accepts
    f.env.mock_all_auths();
    client.accept_recipient_transfer(&id);
    assert_eq!(client.get_stream(&id).recipient, candidate_c);
}

#[test]
fn propose_rejects_self_transfer_and_sender_as_recipient() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);

    // Self-transfer (new_recipient == current recipient)
    assert_eq!(
        client.try_propose_recipient_transfer(&id, &f.recipient),
        Err(Ok(Error::SelfStream))
    );

    // new_recipient == sender
    assert_eq!(
        client.try_propose_recipient_transfer(&id, &f.sender),
        Err(Ok(Error::SelfStream))
    );
}

#[test]
fn propose_on_cancelled_and_settled_streams_rejected() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let new_recipient = Address::generate(&f.env);

    // Cancelled stream
    let id1 = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    client.cancel_stream(&id1);
    assert_eq!(
        client.try_propose_recipient_transfer(&id1, &new_recipient),
        Err(Ok(Error::InvalidState))
    );

    // Settled stream
    let id2 = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    f.env.ledger().set_timestamp(2_200);
    client.settle(&id2);
    assert_eq!(
        client.try_propose_recipient_transfer(&id2, &new_recipient),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn cancel_by_sender_and_by_recipient() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let new_recipient = Address::generate(&f.env);

    // Cancel by sender
    client.propose_recipient_transfer(&id, &new_recipient);
    client.cancel_recipient_transfer(&id, &f.sender);
    assert_eq!(client.get_pending_recipient(&id), None);

    // Cancel by current recipient
    client.propose_recipient_transfer(&id, &new_recipient);
    client.cancel_recipient_transfer(&id, &f.recipient);
    assert_eq!(client.get_pending_recipient(&id), None);
}

#[test]
fn listing_views_reflect_new_recipient_after_transfer() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let new_recipient = Address::generate(&f.env);

    assert_eq!(
        client
            .list_streams_by_recipient(&f.recipient, &None, &10)
            .streams
            .len(),
        1
    );
    assert_eq!(
        client
            .list_streams_by_recipient(&new_recipient, &None, &10)
            .streams
            .len(),
        0
    );

    client.propose_recipient_transfer(&id, &new_recipient);
    client.accept_recipient_transfer(&id);

    assert_eq!(
        client
            .list_streams_by_recipient(&f.recipient, &None, &10)
            .streams
            .len(),
        0
    );
    let new_page = client.list_streams_by_recipient(&new_recipient, &None, &10);
    assert_eq!(new_page.streams.len(), 1);
    assert_eq!(new_page.streams.get(0).unwrap().id, id);

    let status_page =
        client.list_streams_recipient_status(&new_recipient, &StreamStatus::Active, &None, &10);
    assert_eq!(status_page.streams.len(), 1);
    assert_eq!(status_page.streams.get(0).unwrap().id, id);
}

#[test]
fn withdrawer_allowlist_cleared_on_acceptance() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let delegate = Address::generate(&f.env);
    let new_recipient = Address::generate(&f.env);

    client.add_withdrawer(&id, &delegate);
    assert_eq!(client.get_withdrawer_allowlist(&id).len(), 1);

    client.propose_recipient_transfer(&id, &new_recipient);
    client.accept_recipient_transfer(&id);

    assert_eq!(client.get_withdrawer_allowlist(&id).len(), 0);
    f.env.ledger().set_timestamp(1_600);
    assert_eq!(
        client.try_withdraw(&delegate, &id, &100),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn edge_case_proposal_while_stream_paused_and_cancel_routing() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let token = TokenClient::new(&f.env, &f.token);
    let new_recipient = Address::generate(&f.env);

    // 1000 tokens over [1100, 2100]
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    f.env.ledger().set_timestamp(1_600);
    client.pause(&id);

    // Propose and accept while stream is Paused
    client.propose_recipient_transfer(&id, &new_recipient);
    client.accept_recipient_transfer(&id);
    assert_eq!(client.get_stream(&id).recipient, new_recipient);

    // Cancel stream: vested (500) goes to new_recipient, unvested (500) refunded to sender
    let sender_before = token.balance(&f.sender);
    client.cancel_stream(&id);
    assert_eq!(token.balance(&new_recipient), 500);
    assert_eq!(token.balance(&f.recipient), 0);
    assert_eq!(token.balance(&f.sender) - sender_before, 500);
}

#[test]
fn edge_case_transfer_then_settle_and_fee_accounting_unchanged() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let token = TokenClient::new(&f.env, &f.token);
    let collector = Address::generate(&f.env);
    let new_recipient = Address::generate(&f.env);

    client.set_fee_collector(&f.admin, &collector);

    // 1000 tokens with 500 bps (5%) fee over [1100, 2100]
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 500);
    client.propose_recipient_transfer(&id, &new_recipient);
    client.accept_recipient_transfer(&id);

    // Fee bps is preserved after transfer
    assert_eq!(client.get_stream(&id).fee_bps, 500);

    // Withdraw 400 at midpoint -> 5% fee (20) to collector, 380 to new_recipient
    f.env.ledger().set_timestamp(1_600);
    client.withdraw(&new_recipient, &id, &400);
    assert_eq!(token.balance(&new_recipient), 380);
    assert_eq!(token.balance(&collector), 20);

    // Settle after end_time -> remaining 600 paid to new_recipient
    f.env.ledger().set_timestamp(2_200);
    client.settle(&id);
    assert_eq!(token.balance(&new_recipient), 380 + 600);
    assert_eq!(token.balance(&f.recipient), 0);
    assert_eq!(client.get_stream(&id).status, StreamStatus::Settled);
}

#[test]
fn events_emitted_for_propose_accept_and_cancel() {
    let f = setup();
    let client = ContractClient::new(&f.env, &f.contract_id);
    let id = create_active_stream(&f, 1_000, 1_100, 2_100, 0);
    let new_recipient = Address::generate(&f.env);

    // Propose event
    f.env.events().all();
    f.env.ledger().set_timestamp(1_200);
    client.propose_recipient_transfer(&id, &new_recipient);
    let evts = f.env.events().all();
    assert_eq!(evts.len(), 1);
    let (_, topics, _) = evts.first().unwrap();
    assert_eq!(
        topics.get_unchecked(1),
        Symbol::new(&f.env, "recipient_transfer_proposed").into_val(&f.env)
    );

    // Cancel event
    f.env.ledger().set_timestamp(1_210);
    client.cancel_recipient_transfer(&id, &f.sender);
    let evts = f.env.events().all();
    assert_eq!(evts.len(), 1);
    let (_, topics, _) = evts.first().unwrap();
    assert_eq!(
        topics.get_unchecked(1),
        Symbol::new(&f.env, "recipient_transfer_cancelled").into_val(&f.env)
    );

    // Propose again then accept event
    client.propose_recipient_transfer(&id, &new_recipient);
    f.env.events().all();
    f.env.ledger().set_timestamp(1_220);
    client.accept_recipient_transfer(&id);
    let evts = f.env.events().all();
    assert_eq!(evts.len(), 1);
    let (_, topics, _) = evts.first().unwrap();
    assert_eq!(
        topics.get_unchecked(1),
        Symbol::new(&f.env, "recipient_transfer_accepted").into_val(&f.env)
    );
}
