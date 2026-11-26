//! Tests for the `reject_stream` entrypoint: a recipient declining a `Draft`
//! stream that was created for them.
//!
//! ## Running
//!
//! ```text
//! cargo test -p streampay-stream --test reject_stream
//! ```

#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    symbol_short,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol, Val,
};
use streampay_stream::{Contract, ContractClient, Error, StreamStatus};

const MINT: i128 = 1_000_000;
const TOTAL: i128 = 10_000;
const DURATION: u64 = 100;

struct Fixture {
    env: Env,
    contract_id: Address,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let contract_id = env.register(Contract, ());
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        StellarAssetClient::new(&env, &token).mint(&sender, &MINT);
        ContractClient::new(&env, &contract_id).initialize(&admin);

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

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn draft(&self) -> u64 {
        self.client().create_draft_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &TOTAL,
            &DURATION,
        )
    }
}

// ── Success path ──────────────────────────────────────────────────────────

#[test]
fn recipient_rejects_draft_and_sender_is_fully_refunded() {
    let f = Fixture::new();
    let before = f.balance(&f.sender);

    let id = f.draft();
    assert_eq!(f.balance(&f.sender), before - TOTAL, "escrow taken");
    assert_eq!(f.balance(&f.contract_id), TOTAL);

    f.env.ledger().set_timestamp(1_040);
    let stream = f.client().reject_stream(&id);

    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert_eq!(stream.last_update, 1_040);
    assert_eq!(stream.released_amount, 0);
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Cancelled);

    assert_eq!(
        f.balance(&f.sender),
        before,
        "sender back to pre-creation balance"
    );
    assert_eq!(f.balance(&f.contract_id), 0, "no residual escrow");
    assert_eq!(f.balance(&f.recipient), 0, "recipient receives nothing");
}

#[test]
fn reject_decrements_sender_stream_count_once() {
    let f = Fixture::new();
    let id = f.draft();
    assert_eq!(f.client().sender_stream_count(&f.sender), 1);

    f.client().reject_stream(&id);
    assert_eq!(f.client().sender_stream_count(&f.sender), 0);

    // A second reject fails and must not decrement again.
    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::InvalidState
    );
    assert_eq!(f.client().sender_stream_count(&f.sender), 0);
}

#[test]
fn reject_emits_stream_rejected_event_after_transfer() {
    let f = Fixture::new();
    let id = f.draft();
    f.env.events().all(); // drain
    f.env.ledger().set_timestamp(1_077);

    f.client().reject_stream(&id);

    let events = f.env.events().all();
    let (_, topics, payload) = events.last().expect("an event must be emitted");
    let topic0: Symbol = topics.get_unchecked(0).into_val(&f.env);
    let topic1: Symbol = topics.get_unchecked(1).into_val(&f.env);
    assert_eq!(topic0, symbol_short!("stream"));
    assert_eq!(topic1, Symbol::new(&f.env, "rejected"));

    let fields: soroban_sdk::Vec<Val> = payload.into_val(&f.env);
    assert_eq!(
        fields.len(),
        4,
        "stream_id | recipient | returned_amount | timestamp"
    );
    let got_id: u64 = fields.get_unchecked(0).into_val(&f.env);
    let got_recipient: Address = fields.get_unchecked(1).into_val(&f.env);
    let got_returned: i128 = fields.get_unchecked(2).into_val(&f.env);
    let got_ts: u64 = fields.get_unchecked(3).into_val(&f.env);
    assert_eq!(got_id, id);
    assert_eq!(got_recipient, f.recipient);
    assert_eq!(got_returned, TOTAL);
    assert_eq!(got_ts, 1_077);
}

// ── Authorisation ─────────────────────────────────────────────────────────

#[test]
fn only_the_recipient_can_reject() {
    let f = Fixture::new();
    let id = f.draft();

    // Authorise only the sender for `reject_stream`: the recipient check fails.
    f.env.mock_auths(&[MockAuth {
        address: &f.sender,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "reject_stream",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        f.client().try_reject_stream(&id).is_err(),
        "the sender must not be able to reject"
    );

    // State is untouched and the draft is still rejectable by the recipient.
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Draft);
    f.env.mock_all_auths();
    assert_eq!(
        f.client().reject_stream(&id).status,
        StreamStatus::Cancelled
    );
}

// ── State checks ──────────────────────────────────────────────────────────

#[test]
fn reject_after_start_stream_is_refused() {
    let f = Fixture::new();
    let id = f.draft();
    f.client().start_stream(&id);

    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::InvalidState
    );
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Active);
    assert_eq!(f.balance(&f.contract_id), TOTAL, "escrow untouched");
}

#[test]
fn reject_of_a_paused_stream_is_refused() {
    let f = Fixture::new();
    let id = f.draft();
    f.client().start_stream(&id);
    f.env.ledger().set_timestamp(1_010);
    f.client().pause(&id);

    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::InvalidState
    );
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Paused);
}

#[test]
fn reject_after_sender_cancelled_is_refused() {
    let f = Fixture::new();
    let id = f.draft();
    f.client().cancel_stream(&id);
    let before = f.balance(&f.sender);

    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::InvalidState
    );
    assert_eq!(f.balance(&f.sender), before, "no second refund");
}

#[test]
fn reject_of_a_settled_stream_is_refused() {
    let f = Fixture::new();
    let id = f.draft();
    f.client().start_stream(&id);
    f.env.ledger().set_timestamp(1_000 + DURATION + 1);
    f.client().settle(&id);
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Settled);

    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::InvalidState
    );
}

#[test]
fn reject_of_an_unknown_stream_is_not_found() {
    let f = Fixture::new();
    assert_eq!(
        f.client().try_reject_stream(&999).unwrap_err().unwrap(),
        Error::NotFound
    );
}

#[test]
fn reject_is_blocked_while_the_contract_is_paused() {
    let f = Fixture::new();
    let id = f.draft();
    f.client().set_paused(&f.admin, &true);

    assert_eq!(
        f.client().try_reject_stream(&id).unwrap_err().unwrap(),
        Error::ContractPaused
    );
    assert_eq!(f.client().get_stream(&id).status, StreamStatus::Draft);

    f.client().set_paused(&f.admin, &false);
    assert_eq!(
        f.client().reject_stream(&id).status,
        StreamStatus::Cancelled
    );
}

// ── Interplay with existing flows ─────────────────────────────────────────

#[test]
fn reject_does_not_reset_the_sender_cooloff() {
    let f = Fixture::new();
    f.client().set_cooloff_duration(&f.admin, &50);
    let id = f.draft();
    let until = f.client().get_cooloff_until(&f.sender);
    assert!(until > 1_000, "creating a draft starts the cooloff");

    f.client().reject_stream(&id);
    assert_eq!(
        f.client().get_cooloff_until(&f.sender),
        until,
        "rejecting neither extends nor clears the sender's cooloff"
    );
}

#[test]
fn start_and_cancel_flows_are_unchanged() {
    let f = Fixture::new();

    let started = f.draft();
    assert_eq!(
        f.client().start_stream(&started).status,
        StreamStatus::Active
    );

    let cancelled = f.draft();
    f.env.ledger().set_timestamp(1_001);
    assert_eq!(
        f.client().cancel_stream(&cancelled).status,
        StreamStatus::Cancelled
    );
}
