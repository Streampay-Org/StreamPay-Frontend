//! Integration tests for paginated split stream and recurring stream views:
//! - `list_split_streams_by_recipient`
//! - `list_recurring_by_sender`

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, Vec};
use streampay_stream::{Contract, ContractClient, StreamStatus};

struct TestContext {
    env: Env,
    sender_a: Address,
    sender_b: Address,
    recipient_a: Address,
    recipient_b: Address,
    recipient_c: Address,
    token: Address,
    client: ContractClient<'static>,
}

fn setup() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(Contract, ());
    let client = ContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender_a = Address::generate(&env);
    let sender_b = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let recipient_b = Address::generate(&env);
    let recipient_c = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    client.initialize(&admin);

    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&sender_a, &1_000_000_000);
    sac.mint(&sender_b, &1_000_000_000);
    sac.mint(&recipient_a, &0);
    sac.mint(&recipient_b, &0);
    sac.mint(&recipient_c, &0);

    TestContext {
        env,
        sender_a,
        sender_b,
        recipient_a,
        recipient_b,
        recipient_c,
        token,
        client,
    }
}

fn create_split(
    ctx: &TestContext,
    sender: &Address,
    recipients: &[&Address],
    weights: &[u64],
) -> u64 {
    let mut r_vec = Vec::new(&ctx.env);
    for r in recipients {
        r_vec.push_back((*r).clone());
    }
    let mut w_vec = Vec::new(&ctx.env);
    for w in weights {
        w_vec.push_back(*w);
    }
    ctx.client.create_split_stream(
        sender,
        &ctx.token,
        &1_000,
        &1_000,
        &2_000,
        &r_vec,
        &w_vec,
    )
}

fn create_recurring(ctx: &TestContext, sender: &Address, recipient: &Address) -> u64 {
    ctx.client
        .create_recurring_stream(sender, recipient, &ctx.token, &100, &60, &5, &1_000, &0)
}

// ── Split stream view tests ──────────────────────────────────────────────────

#[test]
fn split_view_empty_contract() {
    let ctx = setup();
    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &10);
    assert_eq!(page.streams.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn split_view_address_with_no_records() {
    let ctx = setup();
    create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);

    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_c, &None, &10);
    assert_eq!(page.streams.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn split_view_filtering_ordering_and_pagination() {
    let ctx = setup();

    // ID 1: recipient_a, recipient_b
    let id1 = create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);
    // ID 2: recipient_b, recipient_c (does not include recipient_a)
    let _id2 = create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_b, &ctx.recipient_c], &[50, 50]);
    // ID 3: recipient_a, recipient_c
    let id3 = create_split(&ctx, &ctx.sender_b, &[&ctx.recipient_a, &ctx.recipient_c], &[30, 70]);
    // ID 4: recipient_a, recipient_b
    let id4 = create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[40, 60]);
    // ID 5: recipient_b, recipient_c (does not include recipient_a)
    let _id5 = create_split(&ctx, &ctx.sender_b, &[&ctx.recipient_b, &ctx.recipient_c], &[20, 80]);

    assert_eq!(id1, 1);
    assert_eq!(id3, 3);
    assert_eq!(id4, 4);

    // Page 1: limit 2 -> returns IDs 1, 3; last scanned id is 3 and more ids remain (4, 5)
    let p1 = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &2);
    assert_eq!(p1.streams.len(), 2);
    assert_eq!(p1.streams.get(0).unwrap().id, 1);
    assert_eq!(p1.streams.get(1).unwrap().id, 3);
    assert_eq!(p1.next_cursor, Some(3));

    // Page 2: start_after = Some(3), limit 2 -> returns ID 4; scans through 5, reaches end
    let p2 = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &p1.next_cursor, &2);
    assert_eq!(p2.streams.len(), 1);
    assert_eq!(p2.streams.get(0).unwrap().id, 4);
    assert_eq!(p2.next_cursor, None);

    // Cursor past the last ID
    let past = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &Some(999), &10);
    assert_eq!(past.streams.len(), 0);
    assert_eq!(past.next_cursor, None);
}

#[test]
fn split_view_limit_zero_does_not_panic() {
    let ctx = setup();
    create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);

    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &0);
    assert_eq!(page.streams.len(), 0);
}

#[test]
fn split_view_duplicate_recipient_allocations_returned_once() {
    let ctx = setup();

    // recipient_a appears twice in the same split stream
    let id = create_split(
        &ctx,
        &ctx.sender_a,
        &[&ctx.recipient_a, &ctx.recipient_a, &ctx.recipient_b],
        &[25, 25, 50],
    );

    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &10);
    assert_eq!(page.streams.len(), 1);
    assert_eq!(page.streams.get(0).unwrap().id, id);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn split_view_cancelled_streams_still_listed() {
    let ctx = setup();

    let id = create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);
    ctx.client.cancel_split_stream(&id);

    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &10);
    assert_eq!(page.streams.len(), 1);
    let stream = page.streams.get(0).unwrap();
    assert_eq!(stream.id, id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn split_view_caps_limit_above_max_page_size() {
    let ctx = setup();

    for _ in 0..105 {
        create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);
    }

    // Requesting 200 should be capped at MAX_PAGE_SIZE (100)
    let p1 = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &200);
    assert_eq!(p1.streams.len(), 100);
    assert_eq!(p1.streams.get(0).unwrap().id, 1);
    assert_eq!(p1.streams.get(99).unwrap().id, 100);
    assert_eq!(p1.next_cursor, Some(100));

    let p2 = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &p1.next_cursor, &200);
    assert_eq!(p2.streams.len(), 5);
    assert_eq!(p2.streams.get(0).unwrap().id, 101);
    assert_eq!(p2.streams.get(4).unwrap().id, 105);
    assert_eq!(p2.next_cursor, None);
}

#[test]
fn split_view_requires_no_auth() {
    let ctx = setup();
    create_split(&ctx, &ctx.sender_a, &[&ctx.recipient_a, &ctx.recipient_b], &[50, 50]);

    let page = ctx
        .client
        .list_split_streams_by_recipient(&ctx.recipient_a, &None, &10);
    assert_eq!(page.streams.len(), 1);
    assert!(ctx.env.auths().is_empty());
}

// ── Recurring stream view tests ──────────────────────────────────────────────

#[test]
fn recurring_view_empty_contract() {
    let ctx = setup();
    let page = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &10);
    assert_eq!(page.streams.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn recurring_view_address_with_no_records() {
    let ctx = setup();
    create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);

    let page = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_b, &None, &10);
    assert_eq!(page.streams.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn recurring_view_filtering_ordering_and_pagination() {
    let ctx = setup();

    // ID 1: sender_a
    let id1 = create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);
    // ID 2: sender_b
    let _id2 = create_recurring(&ctx, &ctx.sender_b, &ctx.recipient_a);
    // ID 3: sender_a
    let id3 = create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_b);
    // ID 4: sender_a
    let id4 = create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_c);
    // ID 5: sender_b
    let _id5 = create_recurring(&ctx, &ctx.sender_b, &ctx.recipient_b);

    assert_eq!(id1, 1);
    assert_eq!(id3, 3);
    assert_eq!(id4, 4);

    // Page 1: limit 2 -> returns IDs 1, 3; last scanned id is 3 and more ids remain
    let p1 = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &2);
    assert_eq!(p1.streams.len(), 2);
    assert_eq!(p1.streams.get(0).unwrap().id, 1);
    assert_eq!(p1.streams.get(1).unwrap().id, 3);
    assert_eq!(p1.next_cursor, Some(3));

    // Page 2: start_after = Some(3), limit 2 -> returns ID 4; reaches end
    let p2 = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &p1.next_cursor, &2);
    assert_eq!(p2.streams.len(), 1);
    assert_eq!(p2.streams.get(0).unwrap().id, 4);
    assert_eq!(p2.next_cursor, None);

    // Cursor past the last ID
    let past = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &Some(999), &10);
    assert_eq!(past.streams.len(), 0);
    assert_eq!(past.next_cursor, None);
}

#[test]
fn recurring_view_limit_zero_does_not_panic() {
    let ctx = setup();
    create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);

    let page = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &0);
    assert_eq!(page.streams.len(), 0);
}

#[test]
fn recurring_view_cancelled_streams_still_listed() {
    let ctx = setup();

    let id = create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);
    ctx.client.cancel_recurring_stream(&id);

    let page = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &10);
    assert_eq!(page.streams.len(), 1);
    let stream = page.streams.get(0).unwrap();
    assert_eq!(stream.id, id);
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn recurring_view_caps_limit_above_max_page_size() {
    let ctx = setup();

    for _ in 0..105 {
        create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);
    }

    // Requesting 200 should be capped at MAX_PAGE_SIZE (100)
    let p1 = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &200);
    assert_eq!(p1.streams.len(), 100);
    assert_eq!(p1.streams.get(0).unwrap().id, 1);
    assert_eq!(p1.streams.get(99).unwrap().id, 100);
    assert_eq!(p1.next_cursor, Some(100));

    let p2 = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &p1.next_cursor, &200);
    assert_eq!(p2.streams.len(), 5);
    assert_eq!(p2.streams.get(0).unwrap().id, 101);
    assert_eq!(p2.streams.get(4).unwrap().id, 105);
    assert_eq!(p2.next_cursor, None);
}

#[test]
fn recurring_view_requires_no_auth() {
    let ctx = setup();
    create_recurring(&ctx, &ctx.sender_a, &ctx.recipient_a);

    let page = ctx
        .client
        .list_recurring_by_sender(&ctx.sender_a, &None, &10);
    assert_eq!(page.streams.len(), 1);
    assert!(ctx.env.auths().is_empty());
}
