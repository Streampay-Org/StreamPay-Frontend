//! # Per-token protocol fee overrides
//!
//! Covers the fee precedence introduced for per-token overrides:
//!
//! 1. explicit per-stream `fee_bps` (non-zero at creation);
//! 2. the per-token override;
//! 3. the global default.
//!
//! A stream created with `fee_bps = 0` carries no per-stream fee, so it follows
//! token and default changes. A stream created with a non-zero `fee_bps` keeps
//! that stored value; later token overrides never rewrite it.

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env};
use streampay_stream::{Contract, ContractClient, Error};

const STREAM_AMOUNT: i128 = 1_000;
const START: u64 = 1_000;
const END: u64 = 2_000;

struct Fixture {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    collector: Address,
    contract_id: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(START);

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let collector = Address::generate(&env);
        let contract_id = env.register(Contract, ());

        let fixture = Self {
            env,
            admin,
            sender,
            recipient,
            collector,
            contract_id,
        };

        fixture.client().initialize(&fixture.admin);
        fixture
            .client()
            .set_fee_collector(&fixture.admin, &fixture.collector);

        fixture
    }

    fn client(&self) -> ContractClient<'_> {
        ContractClient::new(&self.env, &self.contract_id)
    }

    /// Registers a token and funds the sender, recipient, and collector.
    fn token(&self) -> Address {
        let token = self
            .env
            .register_stellar_asset_contract_v2(self.admin.clone())
            .address();
        let asset = StellarAssetClient::new(&self.env, &token);
        asset.mint(&self.sender, &1_000_000);
        asset.mint(&self.recipient, &0);
        asset.mint(&self.collector, &0);
        token
    }

    fn create(&self, token: &Address, fee_bps: u32) -> u64 {
        self.client().create_stream(
            &self.sender,
            &self.recipient,
            token,
            &STREAM_AMOUNT,
            &START,
            &END,
            &fee_bps,
        )
    }

    fn withdraw_all(&self, stream_id: u64) {
        self.env.ledger().set_timestamp(END);
        self.client()
            .withdraw(&self.recipient, &stream_id, &STREAM_AMOUNT);
    }

    fn balance(&self, token: &Address, who: &Address) -> i128 {
        StellarAssetClient::new(&self.env, token).balance(who)
    }
}

#[test]
fn token_override_applies_to_streams_without_explicit_fee() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture.client().set_default_fee_bps(&fixture.admin, &100);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &500);

    let stream_id = fixture.create(&token, 0);
    assert_eq!(
        fixture.client().get_stream_fee_bps(&stream_id),
        500
    );

    let collector_before = fixture.balance(&token, &fixture.collector);
    let recipient_before = fixture.balance(&token, &fixture.recipient);

    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        50,
        "5% of 1_000 should go to the collector"
    );
    assert_eq!(
        fixture.balance(&token, &fixture.recipient) - recipient_before,
        950
    );
}

#[test]
fn different_tokens_use_their_own_overrides() {
    let fixture = Fixture::new();
    let token_a = fixture.token();
    let token_b = fixture.token();

    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token_a, &100);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token_b, &500);

    let stream_a = fixture.create(&token_a, 0);
    let stream_b = fixture.create(&token_b, 0);

    let collector_a_before = fixture.balance(&token_a, &fixture.collector);
    let collector_b_before = fixture.balance(&token_b, &fixture.collector);

    fixture.withdraw_all(stream_a);
    fixture.withdraw_all(stream_b);

    assert_eq!(
        fixture.balance(&token_a, &fixture.collector) - collector_a_before,
        10,
        "token A carries a 1% fee"
    );
    assert_eq!(
        fixture.balance(&token_b, &fixture.collector) - collector_b_before,
        50,
        "token B carries a 5% fee"
    );
}

#[test]
fn token_without_override_uses_default() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture.client().set_default_fee_bps(&fixture.admin, &200);
    let stream_id = fixture.create(&token, 0);

    let collector_before = fixture.balance(&token, &fixture.collector);
    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        20
    );
}

#[test]
fn explicit_stream_fee_beats_token_override() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &500);
    let stream_id = fixture.create(&token, 250);

    assert_eq!(
        fixture.client().get_stream_fee_bps(&stream_id),
        250
    );

    let collector_before = fixture.balance(&token, &fixture.collector);
    let recipient_before = fixture.balance(&token, &fixture.recipient);

    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        25
    );
    assert_eq!(
        fixture.balance(&token, &fixture.recipient) - recipient_before,
        975
    );
}

#[test]
fn token_override_never_rewrites_stored_stream_fee() {
    let fixture = Fixture::new();
    let token = fixture.token();

    let implicit = fixture.create(&token, 0);
    let explicit = fixture.create(&token, 250);

    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &700);

    assert_eq!(fixture.client().get_stream(&implicit).fee_bps, 0);
    assert_eq!(fixture.client().get_stream(&explicit).fee_bps, 250);

    assert_eq!(
        fixture.client().get_stream_fee_bps(&implicit),
        700,
        "streams without an explicit fee follow the token override"
    );
    assert_eq!(
        fixture.client().get_stream_fee_bps(&explicit),
        250,
        "explicit per-stream fees are unchanged"
    );
}

#[test]
fn override_set_after_creation_applies_to_stream_without_explicit_fee() {
    let fixture = Fixture::new();
    let token = fixture.token();

    let stream_id = fixture.create(&token, 0);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &400);

    assert_eq!(fixture.client().get_stream(&stream_id).fee_bps, 0);

    let collector_before = fixture.balance(&token, &fixture.collector);
    let recipient_before = fixture.balance(&token, &fixture.recipient);

    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        40
    );
    assert_eq!(
        fixture.balance(&token, &fixture.recipient) - recipient_before,
        960
    );
}

#[test]
fn override_set_after_creation_does_not_change_explicit_stream_fee() {
    let fixture = Fixture::new();
    let token = fixture.token();

    let stream_id = fixture.create(&token, 250);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &700);

    let collector_before = fixture.balance(&token, &fixture.collector);
    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        25,
        "the stream keeps its explicit 2.5% fee"
    );
}

#[test]
fn zero_token_override_makes_token_fee_free() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture.client().set_default_fee_bps(&fixture.admin, &500);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &0);

    let stream_id = fixture.create(&token, 0);

    assert_eq!(
        fixture.client().get_stream_fee_bps(&stream_id),
        0
    );

    let collector_before = fixture.balance(&token, &fixture.collector);
    let recipient_before = fixture.balance(&token, &fixture.recipient);

    fixture.withdraw_all(stream_id);

    assert_eq!(
        fixture.balance(&token, &fixture.collector) - collector_before,
        0
    );
    assert_eq!(
        fixture.balance(&token, &fixture.recipient) - recipient_before,
        STREAM_AMOUNT
    );
}

#[test]
fn clearing_override_restores_default() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture.client().set_default_fee_bps(&fixture.admin, &100);
    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &500);
    assert_eq!(
        fixture.client().get_token_fee_bps(&token),
        Some(500)
    );

    fixture
        .client()
        .clear_token_fee_bps(&fixture.admin, &token);

    assert_eq!(fixture.client().get_token_fee_bps(&token), None);

    let stream_id = fixture.create(&token, 0);
    assert_eq!(
        fixture.client().get_stream_fee_bps(&stream_id),
        100
    );
}

#[test]
fn get_token_fee_bps_is_none_when_unset() {
    let fixture = Fixture::new();
    let token = fixture.token();

    assert_eq!(fixture.client().get_token_fee_bps(&token), None);
}

#[test]
fn token_fee_above_max_is_rejected() {
    let fixture = Fixture::new();
    let token = fixture.token();

    let result = fixture
        .client()
        .try_set_token_fee_bps(&fixture.admin, &token, &10_001u32);
    let err = result.expect_err("fee_bps > 10_000 should fail");

    assert_eq!(err, Ok(Error::InvalidFeeBps));
    assert_eq!(fixture.client().get_token_fee_bps(&token), None);
}

#[test]
fn token_fee_at_max_is_accepted() {
    let fixture = Fixture::new();
    let token = fixture.token();

    fixture
        .client()
        .set_token_fee_bps(&fixture.admin, &token, &10_000);

    assert_eq!(
        fixture.client().get_token_fee_bps(&token),
        Some(10_000)
    );
}
