//! # Cross-contract version negotiation
//!
//! Provides a secure handshake protocol for contracts to negotiate compatible
//! protocol versions before engaging in cross-contract operations.
//!
//! ## Protocol
//!
//! The handshake follows a request-response pattern:
//!
//! 1. **Initiator** calls [`handshake_init`] with their supported version range
//! 2. **Responder** validates the range and responds with their chosen version
//! 3. Both parties store the negotiated version for future interactions
//!
//! ## Version format
//!
//! Versions are represented as `u32` values in the format `MAJOR * 1_000_000 + MINOR * 1_000 + PATCH`.
//! For example, version 1.2.3 is represented as `1_002_003`.
//!
//! ## Security
//!
//! - Only the contract admin may initiate handshakes
//! - Version ranges are validated to ensure compatibility
//! - Handshake state is stored in instance storage with proper TTL extension
//! - All state-changing operations require authentication
//! - Overflow-safe arithmetic for version calculations

use crate::error::Error;
use crate::storage;
use soroban_sdk::{contracttype, Address, Env};

// ── Version constants ─────────────────────────────────────────────────────────

/// Current protocol version supported by this contract.
pub const CURRENT_VERSION: u32 = 1_000_000;

/// Minimum compatible version this contract can communicate with.
pub const MIN_COMPATIBLE_VERSION: u32 = 1_000_000;

/// Maximum version this contract can communicate with (inclusive).
pub const MAX_COMPATIBLE_VERSION: u32 = 1_000_000;

/// Storage key for handshake state.
#[derive(Clone)]
#[contracttype]
enum HandshakeKey {
    /// Handshake state for a specific counterparty address.
    Handshake(Address),
}

/// On-chain record of a completed handshake with a counterparty.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct HandshakeState {
    /// The counterparty contract address.
    pub counterparty: Address,
    /// The negotiated protocol version.
    pub negotiated_version: u32,
    /// Ledger timestamp when the handshake was completed.
    pub timestamp: u64,
}

// ── Public helpers ───────────────────────────────────────────────────────────

/// Initiates a handshake with a counterparty contract.
///
/// This function stores the initiator's version range and prepares for
/// the counterparty's response. The handshake is not complete until
/// [`handshake_accept`] is called by the counterparty.
///
/// @param `env` — The Soroban environment.
/// @param `admin` — The contract admin address (must match stored admin).
/// @param `counterparty` — The address of the counterparty contract.
/// @param `min_version` — Minimum version the initiator supports.
/// @param `max_version` — Maximum version the initiator supports.
///
/// @return The timestamp when the handshake was initiated.
///
/// @custom:error [`Error::Unauthorized`] if `admin` is not the contract admin.
/// @custom:error [`Error::NotFound`] if the contract has not been initialised.
/// @custom:error [`Error::InvalidAmount`] if the version range is invalid.
///
/// @custom:auth Requires authorisation from `admin`.
pub fn handshake_init(
    env: &Env,
    admin: &Address,
    counterparty: &Address,
    min_version: u32,
    max_version: u32,
) -> Result<u64, Error> {
    // Auth check
    crate::require_admin(env, admin)?;

    // Validate version range
    if min_version > max_version {
        return Err(Error::InvalidAmount);
    }

    // Check if the range overlaps with our supported versions
    if max_version < MIN_COMPATIBLE_VERSION || min_version > MAX_COMPATIBLE_VERSION {
        return Err(Error::InvalidAmount);
    }

    // Store handshake initiation state
    let timestamp = env.ledger().timestamp();
    let state = HandshakeState {
        counterparty: counterparty.clone(),
        negotiated_version: 0, // 0 means pending
        timestamp,
    };

    env.storage()
        .instance()
        .set(&HandshakeKey::Handshake(counterparty.clone()), &state);

    // Extend instance TTL
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(storage::INSTANCE_TTL_MIN_REMAINING);
    let target = threshold.saturating_add(storage::INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);

    Ok(timestamp)
}

/// Accepts a handshake initiated by a counterparty.
///
/// This function validates the counterparty's version range, selects
/// a compatible version, and stores the negotiated version.
///
/// @param `env` — The Soroban environment.
/// @param `admin` — The contract admin address (must match stored admin).
/// @param `counterparty` — The address of the counterparty contract.
/// @param `their_min_version` — Minimum version the counterparty supports.
/// @param `their_max_version` — Maximum version the counterparty supports.
///
/// @return The negotiated version number.
///
/// @custom:error [`Error::Unauthorized`] if `admin` is not the contract admin.
/// @custom:error [`Error::NotFound`] if the contract has not been initialised.
/// @custom:error [`Error::InvalidAmount`] if no compatible version exists.
///
/// @custom:auth Requires authorisation from `admin`.
pub fn handshake_accept(
    env: &Env,
    admin: &Address,
    counterparty: &Address,
    their_min_version: u32,
    their_max_version: u32,
) -> Result<u32, Error> {
    // Auth check
    crate::require_admin(env, admin)?;

    // Validate their version range
    if their_min_version > their_max_version {
        return Err(Error::InvalidAmount);
    }

    // Find the highest compatible version
    let our_min = MIN_COMPATIBLE_VERSION;
    let our_max = MAX_COMPATIBLE_VERSION;

    // Calculate the intersection of the two ranges
    let intersection_min = their_min_version.max(our_min);
    let intersection_max = their_max_version.min(our_max);

    if intersection_min > intersection_max {
        return Err(Error::InvalidAmount);
    }

    // Select the highest version in the intersection (prefer newer versions)
    let negotiated_version = intersection_max;

    // Store the completed handshake state
    let timestamp = env.ledger().timestamp();
    let state = HandshakeState {
        counterparty: counterparty.clone(),
        negotiated_version,
        timestamp,
    };

    env.storage()
        .instance()
        .set(&HandshakeKey::Handshake(counterparty.clone()), &state);

    // Extend instance TTL
    let threshold = env
        .ledger()
        .sequence()
        .saturating_add(storage::INSTANCE_TTL_MIN_REMAINING);
    let target = threshold.saturating_add(storage::INSTANCE_TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(threshold, target);

    Ok(negotiated_version)
}

/// Returns the handshake state for a counterparty, if any.
///
/// @param `env` — The Soroban environment.
/// @param `counterparty` — The address of the counterparty contract.
///
/// @return `Some(HandshakeState)` if a handshake exists, `None` otherwise.
///
/// @custom:error This function is read-only and never returns an error.
pub fn get_handshake(env: &Env, counterparty: &Address) -> Option<HandshakeState> {
    let state = env
        .storage()
        .instance()
        .get::<HandshakeKey, HandshakeState>(&HandshakeKey::Handshake(counterparty.clone()));

    if state.is_some() {
        // Extend instance TTL on read
        let threshold = env
            .ledger()
            .sequence()
            .saturating_add(storage::INSTANCE_TTL_MIN_REMAINING);
        let target = threshold.saturating_add(storage::INSTANCE_TTL_EXTEND_TO);
        env.storage().instance().extend_ttl(threshold, target);
    }

    state
}

/// Returns the negotiated version for a counterparty, if a handshake exists.
///
/// @param `env` — The Soroban environment.
/// @param `counterparty` — The address of the counterparty contract.
///
/// @return `Some(u32)` if a handshake exists with a negotiated version,
///         `None` if no handshake exists or handshake is pending.
///
/// @custom:error This function is read-only and never returns an error.
pub fn get_negotiated_version(env: &Env, counterparty: &Address) -> Option<u32> {
    get_handshake(env, counterparty).map(|s| s.negotiated_version).filter(|v| *v > 0)
}

/// Checks if a handshake with a counterparty is complete (has a negotiated version).
///
/// @param `env` — The Soroban environment.
/// @param `counterparty` — The address of the counterparty contract.
///
/// @return `true` if a complete handshake exists, `false` otherwise.
///
/// @custom:error This function is read-only and never returns an error.
pub fn is_handshake_complete(env: &Env, counterparty: &Address) -> bool {
    get_negotiated_version(env, counterparty).is_some()
}

/// Removes a handshake with a counterparty.
///
/// This can be used to reset a handshake or clean up outdated handshakes.
///
/// @param `env` — The Soroban environment.
/// @param `admin` — The contract admin address (must match stored admin).
/// @param `counterparty` — The address of the counterparty contract.
///
/// @custom:error [`Error::Unauthorized`] if `admin` is not the contract admin.
/// @custom:error [`Error::NotFound`] if the contract has not been initialised.
///
/// @custom:auth Requires authorisation from `admin`.
pub fn handshake_remove(env: &Env, admin: &Address, counterparty: &Address) -> Result<(), Error> {
    // Auth check
    crate::require_admin(env, admin)?;

    env.storage()
        .instance()
        .remove(&HandshakeKey::Handshake(counterparty.clone()));

    Ok(())
}

/// Returns the current protocol version supported by this contract.
///
/// @return The current version as a `u32`.
///
/// @custom:error This function is read-only and never returns an error.
pub fn current_protocol_version() -> u32 {
    CURRENT_VERSION
}

/// Returns the minimum compatible version this contract can communicate with.
///
/// @return The minimum compatible version as a `u32`.
///
/// @custom:error This function is read-only and never returns an error.
pub fn min_compatible_version() -> u32 {
    MIN_COMPATIBLE_VERSION
}

/// Returns the maximum compatible version this contract can communicate with.
///
/// @return The maximum compatible version as a `u32`.
///
/// @custom:error This function is read-only and never returns an error.
pub fn max_compatible_version() -> u32 {
    MAX_COMPATIBLE_VERSION
}

/// Converts a version tuple (major, minor, patch) to a u32 version number.
///
/// @param `major` — Major version component.
/// @param `minor` — Minor version component.
/// @param `patch` — Patch version component.
///
/// @return The version as a `u32` in the format `MAJOR * 1_000_000 + MINOR * 1_000 + PATCH`.
///
/// @custom:error This function is pure and never returns an error.
pub fn version_from_parts(major: u32, minor: u32, patch: u32) -> u32 {
    major
        .saturating_mul(1_000_000)
        .saturating_add(minor.saturating_mul(1_000))
        .saturating_add(patch)
}

/// Converts a u32 version number to its (major, minor, patch) components.
///
/// @param `version` — The version number as a `u32`.
///
/// @return A tuple of (major, minor, patch).
///
/// @custom:error This function is pure and never returns an error.
pub fn version_to_parts(version: u32) -> (u32, u32, u32) {
    let major = version / 1_000_000;
    let remainder = version % 1_000_000;
    let minor = remainder / 1_000;
    let patch = remainder % 1_000;
    (major, minor, patch)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Contract;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Env};

    /// Minimal contract client for handshake entrypoints.
    #[contract]
    struct HandshakeTestContract;

    #[contractimpl]
    impl HandshakeTestContract {
        pub fn handshake_init(
            env: Env,
            admin: Address,
            counterparty: Address,
            min_version: u32,
            max_version: u32,
        ) -> Result<u64, Error> {
            handshake_init(&env, &admin, &counterparty, min_version, max_version)
        }

        pub fn handshake_accept(
            env: Env,
            admin: Address,
            counterparty: Address,
            their_min_version: u32,
            their_max_version: u32,
        ) -> Result<u32, Error> {
            handshake_accept(
                &env,
                &admin,
                &counterparty,
                their_min_version,
                their_max_version,
            )
        }

        pub fn get_handshake(env: Env, counterparty: Address) -> Option<HandshakeState> {
            get_handshake(&env, &counterparty)
        }

        pub fn get_negotiated_version(env: Env, counterparty: Address) -> Option<u32> {
            get_negotiated_version(&env, &counterparty)
        }

        pub fn is_handshake_complete(env: Env, counterparty: Address) -> bool {
            is_handshake_complete(&env, &counterparty)
        }

        pub fn handshake_remove(env: Env, admin: Address, counterparty: Address) -> Result<(), Error> {
            handshake_remove(&env, &admin, &counterparty)
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        (env, admin)
    }

    fn handshake_client(env: &Env) -> HandshakeTestContractClient<'_> {
        let id = env.register(HandshakeTestContract, ());
        HandshakeTestContractClient::new(env, &id)
    }

    // ── Version conversion ───────────────────────────────────────────────────

    #[test]
    fn version_from_parts_works() {
        assert_eq!(version_from_parts(1, 2, 3), 1_002_003);
        assert_eq!(version_from_parts(0, 0, 0), 0);
        assert_eq!(version_from_parts(255, 255, 255), 255_255_255);
    }

    #[test]
    fn version_to_parts_works() {
        assert_eq!(version_to_parts(1_002_003), (1, 2, 3));
        assert_eq!(version_to_parts(0), (0, 0, 0));
        assert_eq!(version_to_parts(255_255_255), (255, 255, 255));
    }

    #[test]
    fn version_conversion_roundtrip() {
        let versions = vec![0, 1_000_000, 1_002_003, 255_255_255];
        for v in versions {
            let (major, minor, patch) = version_to_parts(v);
            assert_eq!(version_from_parts(major, minor, patch), v);
        }
    }

    // ── Handshake init ───────────────────────────────────────────────────────

    #[test]
    fn handshake_init_stores_pending_state() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        let timestamp = client
            .handshake_init(&admin, &counterparty, &1_000_000, &1_000_000)
            .unwrap();

        let state = client.get_handshake(&counterparty);
        assert!(state.is_some());
        let state = state.unwrap();
        assert_eq!(state.counterparty, counterparty);
        assert_eq!(state.negotiated_version, 0); // Pending
        assert_eq!(state.timestamp, timestamp);
    }

    #[test]
    fn handshake_init_requires_admin_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let hclient = handshake_client(&env);
        let counterparty = Address::generate(&env);

        let result = hclient.try_handshake_init(&impostor, &counterparty, &1_000_000, &1_000_000);
        assert!(result.is_err());
    }

    #[test]
    fn handshake_init_rejects_invalid_range() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        // min > max
        let result = client.try_handshake_init(&admin, &counterparty, &2_000_000, &1_000_000);
        assert!(result.is_err());

        // No overlap with our supported versions
        let result = client.try_handshake_init(&admin, &counterparty, &2_000_000, &3_000_000);
        assert!(result.is_err());
    }

    // ── Handshake accept ────────────────────────────────────────────────────

    #[test]
    fn handshake_accept_negotiates_highest_compatible_version() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        // They support 1.0.0 to 1.5.0, we support 1.0.0 to 1.0.0
        // Should negotiate to 1.0.0
        let negotiated = client
            .handshake_accept(&admin, &counterparty, &1_000_000, &1_005_000)
            .unwrap();

        assert_eq!(negotiated, 1_000_000);

        let state = client.get_handshake(&counterparty);
        assert!(state.is_some());
        let state = state.unwrap();
        assert_eq!(state.negotiated_version, 1_000_000);
    }

    #[test]
    fn handshake_accept_rejects_incompatible_range() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        // They support 2.0.0 to 3.0.0, we support 1.0.0 to 1.0.0
        // No overlap
        let result = client.try_handshake_accept(&admin, &counterparty, &2_000_000, &3_000_000);
        assert!(result.is_err());
    }

    #[test]
    fn handshake_accept_requires_admin_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let hclient = handshake_client(&env);
        let counterparty = Address::generate(&env);

        let result = hclient.try_handshake_accept(&impostor, &counterparty, &1_000_000, &1_000_000);
        assert!(result.is_err());
    }

    // ── Get handshake ────────────────────────────────────────────────────────

    #[test]
    fn get_handshake_returns_none_for_missing_counterparty() {
        let (env, _admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        let state = client.get_handshake(&counterparty);
        assert!(state.is_none());
    }

    #[test]
    fn get_negotiated_version_returns_none_for_pending_handshake() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        client.handshake_init(&admin, &counterparty, &1_000_000, &1_000_000);

        let version = client.get_negotiated_version(&counterparty);
        assert!(version.is_none());
    }

    #[test]
    fn get_negotiated_version_returns_some_for_complete_handshake() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        client.handshake_accept(&admin, &counterparty, &1_000_000, &1_000_000);

        let version = client.get_negotiated_version(&counterparty);
        assert!(version.is_some());
        assert_eq!(version.unwrap(), 1_000_000);
    }

    #[test]
    fn is_handshake_complete_returns_false_for_pending() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        client.handshake_init(&admin, &counterparty, &1_000_000, &1_000_000);

        assert!(!client.is_handshake_complete(&counterparty));
    }

    #[test]
    fn is_handshake_complete_returns_true_for_complete() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        client.handshake_accept(&admin, &counterparty, &1_000_000, &1_000_000);

        assert!(client.is_handshake_complete(&counterparty));
    }

    // ── Handshake remove ────────────────────────────────────────────────────

    #[test]
    fn handshake_remove_deletes_handshake() {
        let (env, admin) = setup();
        let client = handshake_client(&env);
        let counterparty = Address::generate(&env);

        client.handshake_accept(&admin, &counterparty, &1_000_000, &1_000_000);
        assert!(client.is_handshake_complete(&counterparty));

        client.handshake_remove(&admin, &counterparty).unwrap();
        assert!(!client.is_handshake_complete(&counterparty));
    }

    #[test]
    fn handshake_remove_requires_admin_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        let contract_id = env.register(Contract, ());
        let client = crate::ContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let hclient = handshake_client(&env);
        let counterparty = Address::generate(&env);

        let result = hclient.try_handshake_remove(&impostor, &counterparty);
        assert!(result.is_err());
    }

    // ── Version constants ─────────────────────────────────────────────────────

    #[test]
    fn version_constants_are_valid() {
        assert!(CURRENT_VERSION >= MIN_COMPATIBLE_VERSION);
        assert!(MAX_COMPATIBLE_VERSION >= MIN_COMPATIBLE_VERSION);
        assert!(CURRENT_VERSION <= MAX_COMPATIBLE_VERSION);
    }

    #[test]
    fn current_protocol_version_returns_constant() {
        assert_eq!(current_protocol_version(), CURRENT_VERSION);
    }

    #[test]
    fn min_compatible_version_returns_constant() {
        assert_eq!(min_compatible_version(), MIN_COMPATIBLE_VERSION);
    }

    #[test]
    fn max_compatible_version_returns_constant() {
        assert_eq!(max_compatible_version(), MAX_COMPATIBLE_VERSION);
    }
}
