//! # Admin nonce — focused tests
//!
//! Covers every branch of the nonce-validation logic in `admin.rs` and the
//! two public contract entrypoints exposed through `lib.rs`:
//!
//! - `get_admin_nonce` — read-only nonce query.
//! - `admin_override`  — privileged stream mutation guarded by the nonce.
//!
//! The Soroban test client generates a `try_<name>` variant for every
//! `Result`-returning entrypoint. We use those variants here so we can
//! assert on specific error values without triggering a panic.
//!
//! ## Replay-prevention cases tested
//!
//! | Scenario                          | Expected result          |
//! |-----------------------------------|--------------------------|
//! | First call with nonce 0           | Ok — nonce advances to 1 |
//! | Repeat call with nonce 0 (replay) | Err::NonceTooLow         |
//! | Call with nonce 2 (gap)           | Err::NonceOutOfOrder     |
//! | Sequential calls 0 → 1 → 2       | All Ok                   |
//! | Non-admin caller                  | Err::Unauthorized        |
//! | Terminal stream (Settled)         | Err::InvalidState        |
//! | Terminal stream (Cancelled)       | Err::InvalidState        |
//! | Invalid new_end_time              | Err::InvalidTimeRange    |
//! | get_admin_nonce initial value     | 0                        |
//! | get_admin_nonce after advance     | 1                        |

#[cfg(test)]
mod admin_nonce_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Env, IntoVal,
    };

    use crate::{
        admin,
        error::Error,
        storage::{Stream, StreamStatus},
        Contract,
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────────

    struct Ctx {
        env: Env,
        contract_id: soroban_sdk::Address,
        admin: soroban_sdk::Address,
    }

    impl Ctx {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();
            env.ledger().with_mut(|l| {
                l.timestamp = 1_000;
                l.sequence_number = 1_000;
            });

            let admin = soroban_sdk::Address::generate(&env);
            let contract_id = env.register(Contract, ());
            let client = crate::ContractClient::new(&env, &contract_id);
            client.initialize(&admin);

            Ctx {
                env,
                contract_id,
                admin,
            }
        }

        fn client(&self) -> crate::ContractClient {
            crate::ContractClient::new(&self.env, &self.contract_id)
        }

        /// Inserts a minimal Active stream directly into storage and returns its id.
        fn insert_active_stream(&self) -> u64 {
            let stream_id = 1u64;
            let sender = soroban_sdk::Address::generate(&self.env);
            let recipient = soroban_sdk::Address::generate(&self.env);
            let token = soroban_sdk::Address::generate(&self.env);
            let stream = Stream {
                id: stream_id,
                sender,
                recipient,
                token,
                total_amount: 10_000,
                released_amount: 0,
                start_time: 500,
                end_time: 5_000,
                duration: 4_500,
                last_update: 1_000,
                status: StreamStatus::Active,
                paused_at: 0,
                total_paused_duration: 0,
            };
            self.env.as_contract(&self.contract_id, || {
                crate::storage::set_stream(&self.env, stream_id, &stream);
            });
            stream_id
        }

        /// Reads the stored nonce directly through the module (bypasses client).
        fn raw_nonce(&self) -> u64 {
            self.env
                .as_contract(&self.contract_id, || admin::get_nonce(&self.env))
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // get_admin_nonce
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn get_admin_nonce_starts_at_zero() {
        let ctx = Ctx::new();
        assert_eq!(ctx.client().get_admin_nonce(), 0);
    }

    #[test]
    fn get_admin_nonce_advances_after_override() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        ctx.client()
            .admin_override(&ctx.admin, &0, &stream_id, &10_000);

        assert_eq!(ctx.client().get_admin_nonce(), 1);
    }

    #[test]
    fn get_admin_nonce_is_idempotent() {
        let ctx = Ctx::new();
        assert_eq!(ctx.client().get_admin_nonce(), 0);
        assert_eq!(ctx.client().get_admin_nonce(), 0);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Happy path
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_first_call_succeeds() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        let updated = ctx
            .client()
            .admin_override(&ctx.admin, &0, &stream_id, &20_000);

        assert_eq!(updated.end_time, 20_000);
        // duration = new_end_time - start_time (500)
        assert_eq!(updated.duration, 20_000 - 500);
    }

    #[test]
    fn admin_override_sequential_nonces_all_succeed() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        ctx.client()
            .admin_override(&ctx.admin, &0, &stream_id, &10_000);

        ctx.env.ledger().with_mut(|l| {
            l.timestamp += admin::ADMIN_COOLDOWN_SECONDS;
        });

        ctx.client()
            .admin_override(&ctx.admin, &1, &stream_id, &15_000);

        ctx.env.ledger().with_mut(|l| {
            l.timestamp += admin::ADMIN_COOLDOWN_SECONDS;
        });

        ctx.client()
            .admin_override(&ctx.admin, &2, &stream_id, &20_000);

        assert_eq!(ctx.client().get_admin_nonce(), 3);
    }

    #[test]
    fn admin_override_cooldown_enforced() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        // First call succeeds
        ctx.client()
            .admin_override(&ctx.admin, &0, &stream_id, &10_000);

        // Immediate second call should fail with AdminCooldown
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &1, &stream_id, &15_000)
            .expect_err("cooldown must block rapid admin actions");

        assert_eq!(err, Ok(Error::AdminCooldown));

        // Advance time just before the cooldown expires, should still fail
        ctx.env.ledger().with_mut(|l| {
            l.timestamp += admin::ADMIN_COOLDOWN_SECONDS - 1;
        });

        let err_almost = ctx
            .client()
            .try_admin_override(&ctx.admin, &1, &stream_id, &15_000)
            .expect_err("cooldown must block until fully elapsed");

        assert_eq!(err_almost, Ok(Error::AdminCooldown));

        // Advance time past the cooldown
        ctx.env.ledger().with_mut(|l| {
            l.timestamp += 1;
        });

        // Should succeed now
        ctx.client()
            .admin_override(&ctx.admin, &1, &stream_id, &15_000);

        assert_eq!(ctx.client().get_admin_nonce(), 2);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Replay prevention — core security invariant
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_replay_returns_nonce_too_low() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        // Consume nonce 0.
        ctx.client()
            .admin_override(&ctx.admin, &0, &stream_id, &10_000);

        // Replay: same nonce must be rejected.
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &15_000)
            .expect_err("replay must fail");

        assert_eq!(err, Ok(Error::NonceTooLow));
    }

    #[test]
    fn admin_override_stale_nonce_returns_nonce_too_low() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        ctx.client()
            .admin_override(&ctx.admin, &0, &stream_id, &10_000);
        ctx.client()
            .admin_override(&ctx.admin, &1, &stream_id, &15_000);

        // Stored nonce is 2; nonce 0 is stale.
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &20_000)
            .expect_err("stale nonce must fail");

        assert_eq!(err, Ok(Error::NonceTooLow));
    }

    #[test]
    fn admin_override_out_of_order_nonce_returns_nonce_out_of_order() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        // Stored nonce is 0; skip to 2.
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &2, &stream_id, &10_000)
            .expect_err("out-of-order nonce must fail");

        assert_eq!(err, Ok(Error::NonceOutOfOrder));

        // Nonce must not have advanced.
        assert_eq!(ctx.raw_nonce(), 0);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Authorization
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_non_admin_returns_unauthorized() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();
        let impostor = soroban_sdk::Address::generate(&ctx.env);

        let err = ctx
            .client()
            .try_admin_override(&impostor, &0, &stream_id, &10_000)
            .expect_err("non-admin must fail");

        assert_eq!(err, Ok(Error::Unauthorized));

        // Nonce must not have advanced.
        assert_eq!(ctx.raw_nonce(), 0);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Stream-state validation
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_settled_stream_returns_invalid_state() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        ctx.env.as_contract(&ctx.contract_id, || {
            let mut s = crate::storage::get_stream(&ctx.env, stream_id).unwrap();
            s.status = StreamStatus::Settled;
            crate::storage::set_stream(&ctx.env, stream_id, &s);
        });

        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &10_000)
            .expect_err("settled stream must fail");

        assert_eq!(err, Ok(Error::InvalidState));
    }

    #[test]
    fn admin_override_cancelled_stream_returns_invalid_state() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();

        ctx.env.as_contract(&ctx.contract_id, || {
            let mut s = crate::storage::get_stream(&ctx.env, stream_id).unwrap();
            s.status = StreamStatus::Cancelled;
            crate::storage::set_stream(&ctx.env, stream_id, &s);
        });

        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &10_000)
            .expect_err("cancelled stream must fail");

        assert_eq!(err, Ok(Error::InvalidState));
    }

    #[test]
    fn admin_override_missing_stream_returns_not_found() {
        let ctx = Ctx::new();

        // Note: nonce check happens before stream lookup, so we consume nonce
        // first to distinguish NonceTooLow from NotFound.
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &999, &10_000)
            .expect_err("missing stream must fail");

        assert_eq!(err, Ok(Error::NotFound));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Time-range validation
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_end_time_equal_to_start_time_returns_invalid_time_range() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();
        // start_time = 500, so new_end_time = 500 is not strictly greater.

        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &500)
            .expect_err("equal end_time must fail");

        assert_eq!(err, Ok(Error::InvalidTimeRange));
    }

    #[test]
    fn admin_override_end_time_before_start_time_returns_invalid_time_range() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();
        // start_time = 500, so new_end_time = 100 is before it.

        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &100)
            .expect_err("past end_time must fail");

        assert_eq!(err, Ok(Error::InvalidTimeRange));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Admin transfer: old admin rejected, new admin accepted
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_override_rejected_after_admin_transfer() {
        let ctx = Ctx::new();
        let stream_id = ctx.insert_active_stream();
        let new_admin = soroban_sdk::Address::generate(&ctx.env);

        ctx.client().set_admin(&ctx.admin, &new_admin);

        // Old admin: must fail with Unauthorized.
        let err = ctx
            .client()
            .try_admin_override(&ctx.admin, &0, &stream_id, &10_000)
            .expect_err("old admin must fail");

        assert_eq!(err, Ok(Error::Unauthorized));

        // New admin with same nonce (0) must succeed.
        ctx.client()
            .admin_override(&new_admin, &0, &stream_id, &10_000);

        assert_eq!(ctx.client().get_admin_nonce(), 1);
    }
}
