//! # Contract storage layout
//!
//! All persistent state for the `StreamPay` contract is keyed by
//! [`DataKey`]. There are two storage tiers in use:
//!
//! - **Instance storage** holds singletons: `Admin`, `Paused`, the
//!   stream counter, and the per-token allowlist. These keys live for
//!   the lifetime of the contract instance and are extended together.
//! - **Persistent storage** holds per-stream rows keyed by stream id,
//!   and per-stream withdrawer allowlists keyed by stream id.
//!   These rows are TTL-extended every time the stream is read or
//!   written so an active stream cannot expire mid-flight.
//!
//! The TTL constants below are tuned for long-running payment streams
//! plus a generous recovery buffer; keep them in sync with the
//! operational runbook.

use soroban_sdk::{contracttype, Address, Env, Vec};

/// Lifecycle status of a [`Stream`] stored on-chain.
///
/// | Variant     | Description                                                        |
/// |-------------|--------------------------------------------------------------------|
/// | `Draft`     | Created but not yet started; no accrual occurs.                    |
/// | `Active`    | Tokens are vesting linearly from `start_time` to `end_time`.       |
/// | `Paused`    | Accrual frozen; `end_time` will be extended on resume.             |
/// | `Settled`   | Fully paid out; terminal state.                                    |
/// | `Ended`     | Time window elapsed, awaiting settle; transitional.                |
/// | `Cancelled` | Cancelled by sender before full vesting; terminal state.           |
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum StreamStatus {
    Draft,
    Active,
    Paused,
    Settled,
    Ended,
    Cancelled,
}

/// On-chain record for a single payment stream.
///
/// Each stream escrows `total_amount` from `sender` and releases it
/// linearly to `recipient` from `start_time` to `end_time`. The
/// `released_amount` tracks cumulative withdrawals; when it reaches
/// `total_amount` the stream transitions to `Settled`.
///
/// Paused streams record `paused_at` and `total_paused_duration` so
/// that the resumption logic can extend `end_time` by the pause length
/// without over- or under-paying the recipient.
#[derive(Clone, Debug)]
#[contracttype]
pub struct Stream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub duration: u64,
    pub last_update: u64,
    pub status: StreamStatus,
    pub paused_at: u64,
    pub total_paused_duration: u64,
    /// Per-stream fee in basis points `[0, 10_000]`.
    ///
    /// Set at creation time. Applied to every [`crate::Contract::withdraw`]
    /// call: `fee_amount = floor(amount * fee_bps / 10_000)`. If no fee
    /// collector has been configured, the fee is skipped regardless of this
    /// value.
    pub fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub(crate) enum DataKey {
    Admin,
    Paused,
    StreamCount,
    Stream(u64),
    TokenAllowed(Address),
    /// Protocol-level fee in basis points (0–10 000).
    ///
    /// Absent means no fee (equivalent to `0`). Stored in instance storage so
    /// it lives for the lifetime of the contract.
    FeeBps,
    /// Per-stream withdrawer allowlist keyed by stream id (persistent storage).
    WithdrawerAllowlist(u64),
}

/// Threshold and absolute target values are expressed in ledger sequences.
///
/// Stream entries use a 2-week look-ahead threshold and a 3-month extension
/// target, giving active streams a wide safety margin against archival pressure
/// on hot read paths (every `get_stream`, `withdrawable`, and `withdraw` call
/// re-stamps the TTL).
///
/// Instance keys (admin, paused flag, stream counter) use a 1-week threshold
/// and a 1-month target; they are touched on every state-changing call so they
/// stay warm under normal operation.
///
/// Token-allowlist entries share the instance cadence: 1-week threshold,
/// 1-month target. They are re-stamped on every `create_stream` check and on
/// every admin `set_token_allowed` write.
pub const STREAM_TTL_MIN_REMAINING: u32 = 241_920; // ~2 weeks at 5-second ledgers
pub const STREAM_TTL_EXTEND_TO: u32 = 1_555_200; // ~3 months at 5-second ledgers
pub const INSTANCE_TTL_MIN_REMAINING: u32 = 120_960; // ~1 week at 5-second ledgers
pub const INSTANCE_TTL_EXTEND_TO: u32 = 518_400; // ~1 month at 5-second ledgers
/// Per-token allowlist TTL constants.
///
/// Every `is_token_blocked` call (hot path inside `create_stream`) extends
/// the allowlist entry's TTL so a token that is actively being streamed
/// cannot silently archive between stream creation and withdrawal.
pub const TOKEN_TTL_MIN_REMAINING: u32 = 120_960; // ~1 week at 5-second ledgers
pub const TOKEN_TTL_EXTEND_TO: u32 = 518_400; // ~1 month at 5-second ledgers

fn ttl_target(env: &Env, extra_ledgers: u32) -> u32 {
    env.ledger().sequence().saturating_add(extra_ledgers)
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    // In soroban-sdk 23.x, get_ttl is only available via testutils and the
    // extend_ttl call itself short-circuits when the key's TTL is already
    // above the threshold. We therefore call extend_ttl unconditionally
    // with the minimum remaining TTL as the threshold.
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(STREAM_TTL_MIN_REMAINING);
    let target = ttl_target(env, STREAM_TTL_EXTEND_TO);
    env.storage()
        .persistent()
        .extend_ttl(key, threshold, target);
}

fn extend_instance_ttl(env: &Env, _key: &DataKey) {
    // Instance storage in soroban-sdk 23.x does not accept a key argument
    // to extend_ttl; the host function extends the entire current contract
    // instance. The call short-circuits internally when the instance TTL
    // already exceeds the threshold.
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(INSTANCE_TTL_MIN_REMAINING);
    let target = ttl_target(env, INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);
}

fn extend_token_allowed_ttl(env: &Env, token: &Address) {
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(TOKEN_TTL_MIN_REMAINING);
    let target = ttl_target(env, TOKEN_TTL_EXTEND_TO);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::TokenAllowed(token.clone()), threshold, target);
}

fn extend_stream_ttl(env: &Env, stream_id: u64) {
    extend_persistent_ttl(env, &DataKey::Stream(stream_id));
}

fn extend_withdrawer_allowlist_ttl(env: &Env, stream_id: u64) {
    extend_persistent_ttl(env, &DataKey::WithdrawerAllowlist(stream_id));
}

fn extend_admin_key_ttl(env: &Env) {
    extend_instance_ttl(env, &DataKey::Admin);
}

fn extend_pause_key_ttl(env: &Env) {
    extend_instance_ttl(env, &DataKey::Paused);
}

fn extend_next_stream_id_ttl(env: &Env) {
    extend_instance_ttl(env, &DataKey::StreamCount);
}

/// Returns whether an admin key is present in instance storage.
///
/// If the admin key exists, this helper extends its TTL to ensure the
/// governance address does not expire mid-flight.
///
/// # Returns
/// - `true` if [`DataKey::Admin`] exists.
/// - `false` otherwise.
///
/// # Errors
/// This helper does not return errors.
pub fn has_admin(env: &Env) -> bool {
    let exists = env.storage().instance().has(&DataKey::Admin);
    if exists {
        extend_admin_key_ttl(env);
    }
    exists
}

/// Sets the contract admin address in instance storage.
///
/// This helper also extends the admin key TTL.
///
/// # Returns
/// This helper does not return a value.
///
/// # Errors
/// This helper does not return errors.
pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
    extend_admin_key_ttl(env);
}

/// Returns the stored admin address, if any.
///
/// If an admin value exists, this helper extends its TTL.
///
/// # Returns
/// - `Some(Address)` if [`DataKey::Admin`] exists.
/// - `None` otherwise.
///
/// # Errors
/// This helper does not return errors.
pub fn get_admin(env: &Env) -> Option<Address> {
    let admin = env.storage().instance().get(&DataKey::Admin);
    if admin.is_some() {
        extend_admin_key_ttl(env);
    }
    admin
}

/// Sets the global paused flag in instance storage.
///
/// This helper also extends the paused key TTL.
///
/// # Returns
/// This helper does not return a value.
///
/// # Errors
/// This helper does not return errors.
pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
    extend_pause_key_ttl(env);
}

/// Returns whether the contract is currently paused.
///
/// Uses a single storage read to check and retrieve the flag; extends the
/// instance TTL on the hot read path so the paused flag never archives while
/// the contract is actively receiving calls.
///
/// # Returns
/// - `true` if paused is set to `true`.
/// - `false` if paused is unset or set to `false`.
///
/// # Errors
/// This helper does not return errors.
pub fn is_paused(env: &Env) -> bool {
    let result: Option<bool> = env.storage().instance().get(&DataKey::Paused);
    if result.is_some() {
        extend_pause_key_ttl(env);
    }
    result.unwrap_or(false)
}

/// Sets whether a given token is allowed for future stream creation.
///
/// Tokens are allowed by default when there is no entry for the token. When
/// `allowed = false`, the function writes a deny entry that makes the token
/// "blocked" for future stream creation. The entry's TTL is extended on
/// every write so allowlist state does not archive under active use.
///
/// # Returns
/// This helper does not return a value.
///
/// # Errors
/// This helper does not return errors.
pub fn set_token_allowed(env: &Env, token: &Address, allowed: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::TokenAllowed(token.clone()), &allowed);
    extend_token_allowed_ttl(env, token);
}

/// Returns whether a given token is blocked.
///
/// This is the logical negation of `set_token_allowed(..., allowed = true)`.
/// If no allow entry exists, the token is treated as allowed (therefore not
/// blocked). When an entry exists, its TTL is extended so that a token used
/// in a long-running stream does not archive between `create_stream` and the
/// final `withdraw`.
///
/// # Returns
/// - `true` if the token is explicitly blocked.
/// - `false` if explicitly allowed or unset.
///
/// # Errors
/// This helper does not return errors.
pub fn is_token_blocked(env: &Env, token: &Address) -> bool {
    match env
        .storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::TokenAllowed(token.clone()))
    {
        Some(allowed) => {
            extend_token_allowed_ttl(env, token);
            !allowed
        }
        None => false,
    }
}

/// Returns the next stream id and increments the stored counter.
///
/// Stream ids start at `1` when the counter is unset. This helper extends the
/// TTL of the stream id counter key.
///
/// # Returns
/// The stream id that should be assigned to the next created stream.
///
/// # Errors
/// This helper does not return errors.
pub fn next_stream_id(env: &Env) -> u64 {
    let storage = env.storage().instance();
    let id = storage.get(&DataKey::StreamCount).unwrap_or(1u64);
    storage.set(&DataKey::StreamCount, &id.saturating_add(1));
    extend_next_stream_id_ttl(env);
    id
}

/// Returns the next stream id **without** incrementing the counter.
///
/// This is a read-only helper used by paginated list views to determine the
/// upper bound of stream IDs to scan. It does not consume a stream ID or
/// modify any storage state.
///
/// # Returns
/// The value of the next-stream-ID counter (i.e. the ID that *would* be
/// assigned to the next `create_stream` call). Returns `1` if no streams
/// have ever been created.
pub fn peek_next_stream_id(env: &Env) -> u64 {
    let storage = env.storage().instance();
    let id: u64 = storage.get(&DataKey::StreamCount).unwrap_or(1u64);
    // Extend instance TTL on this hot read path so the stream-ID counter
    // never archives while the contract is actively serving paginated views.
    extend_next_stream_id_ttl(env);
    id
}

/// Test-only helper: directly sets the stream-ID counter to `id`.
///
/// Allows unit tests to seed the counter to a known value without having to
/// create actual streams. Not available in production builds.
#[cfg(test)]
pub fn set_next_stream_id_for_test(env: &Env, id: u64) {
    env.storage().instance().set(&DataKey::StreamCount, &id);
}

/// Writes a stream record into persistent storage.
///
/// This helper also extends the TTL for the corresponding per-stream entry.
///
/// # Returns
/// This helper does not return a value.
///
/// # Errors
/// This helper does not return errors.
pub fn set_stream(env: &Env, stream_id: u64, stream: &Stream) {
    env.storage()
        .persistent()
        .set(&DataKey::Stream(stream_id), stream);
    extend_stream_ttl(env, stream_id);
}

/// Reads a stream record from persistent storage.
///
/// If the stream exists, this helper extends the TTL for the corresponding
/// per-stream entry so a frequently queried stream stays live on the hot
/// read path.
///
/// # Returns
/// - `Some(Stream)` if the stream exists.
/// - `None` otherwise.
///
/// # Errors
/// This helper does not return errors.
pub fn get_stream(env: &Env, stream_id: u64) -> Option<Stream> {
    let stream = env.storage().persistent().get(&DataKey::Stream(stream_id));
    if stream.is_some() {
        extend_stream_ttl(env, stream_id);
    }
    stream
}

/// Sets the protocol-level fee in basis points (0–10 000).
///
/// Stored in instance storage so it lives for the contract lifetime. Extends
/// instance TTL on every write to keep the fee configuration alive.
///
/// A value of `0` means no fee is charged; `10_000` means 100 % (full amount).
///
/// # Returns
/// This helper does not return a value.
pub fn set_fee_bps(env: &Env, fee_bps: u32) {
    env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
    extend_instance_ttl(env, &DataKey::FeeBps);
}

/// Returns the current protocol-level fee in basis points.
///
/// Returns `0` if no fee has been configured (absent key). Extends instance
/// TTL on the hot path so the fee configuration stays live under normal use.
///
/// # Returns
/// Fee in basis points, in the range `[0, 10_000]`.
pub fn get_fee_bps(env: &Env) -> u32 {
    let fee: Option<u32> = env.storage().instance().get(&DataKey::FeeBps);
    if fee.is_some() {
        extend_instance_ttl(env, &DataKey::FeeBps);
    }
    fee.unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Withdrawer allowlist
// ---------------------------------------------------------------------------

/// Adds `withdrawer` to the per-stream allowlist for `stream_id`.
pub fn add_withdrawer(env: &Env, stream_id: u64, withdrawer: &Address) {
    let mut allowlist: soroban_sdk::Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::WithdrawerAllowlist(stream_id))
        .unwrap_or(soroban_sdk::Vec::new(env));

    if !allowlist.contains(withdrawer) {
        allowlist.push_back(withdrawer.clone());
    }

    env.storage()
        .persistent()
        .set(&DataKey::WithdrawerAllowlist(stream_id), &allowlist);
    extend_withdrawer_allowlist_ttl(env, stream_id);
}

/// Removes `withdrawer` from the per-stream allowlist for `stream_id`.
pub fn remove_withdrawer(env: &Env, stream_id: u64, withdrawer: &Address) {
    let mut allowlist: soroban_sdk::Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::WithdrawerAllowlist(stream_id))
        .unwrap_or(soroban_sdk::Vec::new(env));

    if let Some(pos) = allowlist.first_index_of(withdrawer) {
        allowlist.remove(pos);
    }

    env.storage()
        .persistent()
        .set(&DataKey::WithdrawerAllowlist(stream_id), &allowlist);
    extend_withdrawer_allowlist_ttl(env, stream_id);
}

/// Returns `true` if `withdrawer` is present in the per-stream allowlist for
/// `stream_id`.
pub fn is_withdrawer_allowed(env: &Env, stream_id: u64, withdrawer: &Address) -> bool {
    let allowlist: Option<soroban_sdk::Vec<Address>> = env
        .storage()
        .persistent()
        .get(&DataKey::WithdrawerAllowlist(stream_id));
    match allowlist {
        Some(list) => {
            extend_withdrawer_allowlist_ttl(env, stream_id);
            list.contains(withdrawer)
        }
        None => false,
    }
}

/// Returns the full withdrawer allowlist for `stream_id` (may be empty).
pub fn get_withdrawer_allowlist(env: &Env, stream_id: u64) -> soroban_sdk::Vec<Address> {
    let allowlist: Option<soroban_sdk::Vec<Address>> = env
        .storage()
        .persistent()
        .get(&DataKey::WithdrawerAllowlist(stream_id));
    match allowlist {
        Some(list) => {
            extend_withdrawer_allowlist_ttl(env, stream_id);
            list
        }
        None => soroban_sdk::Vec::new(env),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Contract;
    use soroban_sdk::{
        testutils::{
            storage::{Instance, Persistent},
            Address as _, Ledger as _,
        },
        Env,
    };

    fn setup() -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        let contract_id = env.register(Contract, ());
        (env, contract_id)
    }

    fn test_stream(env: &Env) -> Stream {
        Stream {
            id: 1,
            sender: soroban_sdk::Address::generate(env),
            recipient: soroban_sdk::Address::generate(env),
            token: soroban_sdk::Address::generate(env),
            total_amount: 1000,
            released_amount: 0,
            start_time: 1000,
            end_time: 2000,
            duration: 1000,
            last_update: 1000,
            status: StreamStatus::Active,
            paused_at: 0,
            total_paused_duration: 0,
            fee_bps: 0,
        }
    }

    // ── constant sanity ──────────────────────────────────────────────────────

    /// Extends must be > 0 and extend_to >= min_remaining for all entry types.
    #[test]
    fn ttl_constants_are_valid() {
        assert!(STREAM_TTL_MIN_REMAINING > 0);
        assert!(STREAM_TTL_EXTEND_TO >= STREAM_TTL_MIN_REMAINING);
        assert!(INSTANCE_TTL_MIN_REMAINING > 0);
        assert!(INSTANCE_TTL_EXTEND_TO >= INSTANCE_TTL_MIN_REMAINING);
        // Token constants: new in this PR, just verify non-zero
        assert!(TOKEN_TTL_MIN_REMAINING > 0);
        assert!(TOKEN_TTL_EXTEND_TO >= TOKEN_TTL_MIN_REMAINING);
    }

    // ── stream TTL ───────────────────────────────────────────────────────────

    /// `set_stream` must write the entry and immediately extend its TTL to
    /// exactly `STREAM_TTL_EXTEND_TO` ledgers from the current sequence.
    #[test]
    fn set_stream_extends_ttl_to_extend_to() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            let s = test_stream(&env);
            set_stream(&env, 1, &s);
            let ttl = env.storage().persistent().get_ttl(&DataKey::Stream(1));
            assert_eq!(ttl, STREAM_TTL_EXTEND_TO);
        });
    }

    /// When the remaining TTL of a stream entry drops just below
    /// `STREAM_TTL_MIN_REMAINING`, `get_stream` must re-extend it to
    /// `STREAM_TTL_EXTEND_TO`.
    #[test]
    fn get_stream_re_extends_ttl_when_below_threshold() {
        let (env, contract_id) = setup();

        env.as_contract(&contract_id, || {
            set_stream(&env, 1, &test_stream(&env));
        });

        // Advance to the ledger where the remaining TTL is MIN_REMAINING - 1.
        let new_seq = STREAM_TTL_EXTEND_TO
            .saturating_sub(STREAM_TTL_MIN_REMAINING)
            .saturating_add(1);
        env.ledger().set_sequence_number(new_seq);

        env.as_contract(&contract_id, || {
            let ttl_before = env.storage().persistent().get_ttl(&DataKey::Stream(1));
            assert_eq!(
                ttl_before,
                STREAM_TTL_MIN_REMAINING - 1,
                "pre-condition: TTL should be exactly one ledger below threshold"
            );

            let _ = get_stream(&env, 1);

            let ttl_after = env.storage().persistent().get_ttl(&DataKey::Stream(1));
            assert_eq!(
                ttl_after, STREAM_TTL_EXTEND_TO,
                "get_stream must re-extend TTL to STREAM_TTL_EXTEND_TO"
            );
        });
    }

    /// `get_stream` on a non-existent stream must return `None` without
    /// panicking — there is no TTL to extend for a missing entry.
    #[test]
    fn get_stream_returns_none_for_missing_id() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            let result = get_stream(&env, 999);
            assert!(result.is_none());
        });
    }

    // ── token-allowlist TTL ──────────────────────────────────────────────────

    /// `set_token_allowed` must write the entry and extend its TTL to
    /// exactly `TOKEN_TTL_EXTEND_TO`.
    #[test]
    fn set_token_allowed_extends_ttl_to_extend_to() {
        let (env, contract_id) = setup();
        let token = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            set_token_allowed(&env, &token, true);
            let ttl = env
                .storage()
                .persistent()
                .get_ttl(&DataKey::TokenAllowed(token.clone()));
            assert_eq!(ttl, TOKEN_TTL_EXTEND_TO);
        });
    }

    /// `is_token_blocked` must re-extend the TTL when the remaining TTL
    /// drops below `TOKEN_TTL_MIN_REMAINING`.  This covers the hot read path
    /// triggered inside `create_stream` on every call.
    #[test]
    fn is_token_blocked_re_extends_ttl_on_hot_read() {
        let (env, contract_id) = setup();
        let token = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_token_allowed(&env, &token, false);
        });

        let new_seq = TOKEN_TTL_EXTEND_TO
            .saturating_sub(TOKEN_TTL_MIN_REMAINING)
            .saturating_add(1);
        env.ledger().set_sequence_number(new_seq);

        env.as_contract(&contract_id, || {
            let ttl_before = env
                .storage()
                .persistent()
                .get_ttl(&DataKey::TokenAllowed(token.clone()));
            assert_eq!(
                ttl_before,
                TOKEN_TTL_MIN_REMAINING - 1,
                "pre-condition: TTL should be exactly one ledger below threshold"
            );

            let blocked = is_token_blocked(&env, &token);
            assert!(blocked, "token should still be blocked");

            let ttl_after = env
                .storage()
                .persistent()
                .get_ttl(&DataKey::TokenAllowed(token.clone()));
            assert_eq!(
                ttl_after, TOKEN_TTL_EXTEND_TO,
                "is_token_blocked must re-extend TTL to TOKEN_TTL_EXTEND_TO"
            );
        });
    }

    /// `is_token_blocked` must also extend TTL when the entry is `allowed = true`.
    #[test]
    fn is_token_blocked_extends_ttl_for_allowed_token() {
        let (env, contract_id) = setup();
        let token = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_token_allowed(&env, &token, true);
        });

        let new_seq = TOKEN_TTL_EXTEND_TO
            .saturating_sub(TOKEN_TTL_MIN_REMAINING)
            .saturating_add(1);
        env.ledger().set_sequence_number(new_seq);

        env.as_contract(&contract_id, || {
            let blocked = is_token_blocked(&env, &token);
            assert!(!blocked, "token should be allowed");

            let ttl_after = env
                .storage()
                .persistent()
                .get_ttl(&DataKey::TokenAllowed(token.clone()));
            assert_eq!(ttl_after - env.ledger().sequence(), TOKEN_TTL_EXTEND_TO);
        });
    }

    /// Calling `is_token_blocked` for a token that has no storage entry must
    /// return `false` without panicking — there is nothing to extend.
    #[test]
    fn is_token_blocked_returns_false_and_no_panic_for_absent_token() {
        let (env, contract_id) = setup();
        let token = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            let blocked = is_token_blocked(&env, &token);
            assert!(!blocked);
        });
    }

    // ── instance TTL (admin + paused flag) ───────────────────────────────────

    /// `set_admin` must extend the instance TTL to `INSTANCE_TTL_EXTEND_TO`.
    #[test]
    fn set_admin_extends_instance_ttl() {
        let (env, contract_id) = setup();
        let admin = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            set_admin(&env, &admin);
            let ttl = env.storage().instance().get_ttl();
            assert_eq!(ttl, INSTANCE_TTL_EXTEND_TO);
        });
    }

    /// `get_admin` must re-extend the instance TTL when called on the hot path.
    #[test]
    fn get_admin_re_extends_instance_ttl() {
        let (env, contract_id) = setup();
        let admin = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_admin(&env, &admin);
        });

        let new_seq = INSTANCE_TTL_EXTEND_TO
            .saturating_sub(INSTANCE_TTL_MIN_REMAINING)
            .saturating_add(1);
        env.ledger().set_sequence_number(new_seq);

        env.as_contract(&contract_id, || {
            let ttl_before = env.storage().instance().get_ttl();
            assert_eq!(ttl_before, INSTANCE_TTL_MIN_REMAINING - 1);

            let _ = get_admin(&env);

            let ttl_after = env.storage().instance().get_ttl();
            assert_eq!(ttl_after - env.ledger().sequence(), INSTANCE_TTL_EXTEND_TO);
        });
    }

    /// `is_paused` must extend the instance TTL on the hot path even when the
    /// contract is not paused — this function is called on every state-changing
    /// entrypoint.
    #[test]
    fn is_paused_re_extends_instance_ttl_on_hot_path() {
        let (env, contract_id) = setup();

        env.as_contract(&contract_id, || {
            set_paused(&env, false);
        });

        let new_seq = INSTANCE_TTL_EXTEND_TO
            .saturating_sub(INSTANCE_TTL_MIN_REMAINING)
            .saturating_add(1);
        env.ledger().set_sequence_number(new_seq);

        env.as_contract(&contract_id, || {
            let ttl_before = env.storage().instance().get_ttl();
            assert_eq!(
                ttl_before,
                INSTANCE_TTL_MIN_REMAINING - 1,
                "pre-condition: TTL should be exactly one ledger below threshold"
            );

            let paused = is_paused(&env);
            assert!(!paused);

            let ttl_after = env.storage().instance().get_ttl();
            assert_eq!(
                ttl_after, INSTANCE_TTL_EXTEND_TO,
                "is_paused must re-extend instance TTL to INSTANCE_TTL_EXTEND_TO"
            );
        });
    }

    /// Calling `is_paused` when no `Paused` key exists must return `false`
    /// without panicking and must NOT attempt to extend a non-existent entry.
    #[test]
    fn is_paused_returns_false_for_unset_flag() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            let paused = is_paused(&env);
            assert!(!paused);
        });
    }

    // ── peek_next_stream_id / set_next_stream_id_for_test ────────────────────

    /// `peek_next_stream_id` returns `1` when no streams have ever been
    /// created — same default as `next_stream_id`.
    #[test]
    fn peek_next_stream_id_returns_one_when_unset() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            assert_eq!(
                peek_next_stream_id(&env),
                1u64,
                "unset counter should default to 1"
            );
        });
    }

    /// After `next_stream_id` is called once, `peek_next_stream_id` must
    /// return `2` (the next ID that *would* be assigned).
    #[test]
    fn peek_next_stream_id_reflects_incremented_counter() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            let assigned = next_stream_id(&env); // consumes ID 1, counter → 2
            assert_eq!(assigned, 1u64);
            assert_eq!(
                peek_next_stream_id(&env),
                2u64,
                "counter must now be 2 after one allocation"
            );
        });
    }

    /// `peek_next_stream_id` must NOT increment the counter — repeated calls
    /// must return the same value.
    #[test]
    fn peek_next_stream_id_is_idempotent() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            let first = peek_next_stream_id(&env);
            let second = peek_next_stream_id(&env);
            assert_eq!(
                first, second,
                "peek must be idempotent — counter must not change"
            );
        });
    }

    /// `set_next_stream_id_for_test` allows tests to seed the counter to any
    /// arbitrary value; subsequent `peek` and `next_stream_id` calls should
    /// observe the new value.
    #[test]
    fn set_next_stream_id_for_test_seeds_counter() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_next_stream_id_for_test(&env, 42);
            assert_eq!(
                peek_next_stream_id(&env),
                42u64,
                "peek must return the value written by the test setter"
            );

            // next_stream_id should consume 42 and advance the counter to 43
            let id = next_stream_id(&env);
            assert_eq!(id, 42u64);
            assert_eq!(peek_next_stream_id(&env), 43u64);
        });
    }

    /// Setting the counter to `1` effectively resets to the empty-contract
    /// state; `next_stream_id` should start again from `1`.
    #[test]
    fn set_next_stream_id_for_test_can_reset_to_one() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            // Advance the counter to 5
            for _ in 0..4 {
                next_stream_id(&env);
            }
            assert_eq!(peek_next_stream_id(&env), 5u64);

            // Reset
            set_next_stream_id_for_test(&env, 1);
            assert_eq!(peek_next_stream_id(&env), 1u64);
            assert_eq!(next_stream_id(&env), 1u64);
        });
    }
}
