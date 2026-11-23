//! # Error discriminant stability tests for `streampay-stream`
//!
//! Integration tests that freeze the numeric error codes assigned to each
//! [`Error`] variant so that accidental renumbering or reuse is caught
//! in CI.
//!
//! ## Why this matters
//!
//! The Soroban contract serialises error codes as raw `u32` values which
//! the backend Web API maps one-to-one into its public Problem+JSON error
//! envelope.  Changing a numeric code after it has shipped is a breaking
//! change for consumers that rely on the integer code.
//!
//! ## What these tests guarantee
//!
//! * Every variant's discriminant matches the value declared in
//!   `src/error.rs`.
//! * The discriminants form a contiguous block from `1` to `21`.
//! * Round-trip [`Error`] → [`u32`] → [`Error`] conversion is lossless.
//! * Unknown [`u32`] values are correctly rejected.
//! * XDR serialisation and deserialisation via the Soroban host environment
//!   is stable for every variant.
//!
//! ## When to update
//!
//! When adding a **new** variant, append a new assertion for it at the end
//! of each test and bump the contiguous-range check.  Never renumber or
//! delete an existing variant.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::Env;
use streampay_stream::Error;

/// Every [`Error`] variant must evaluate to its documented discriminant value.
///
/// See also `src/error.rs` for the canonical source of truth.
#[test]
fn err_discriminants_are_stable() {
    assert_eq!(Error::NotFound as u32, 1);
    assert_eq!(Error::Unauthorized as u32, 2);
    assert_eq!(Error::ContractPaused as u32, 3);
    assert_eq!(Error::InvalidAmount as u32, 4);
    assert_eq!(Error::InvalidTimeRange as u32, 5);
    assert_eq!(Error::InvalidState as u32, 6);
    assert_eq!(Error::OverWithdraw as u32, 7);
    assert_eq!(Error::AlreadySettled as u32, 8);
    assert_eq!(Error::TokenNotAllowed as u32, 9);
    assert_eq!(Error::Overflow as u32, 10);
    assert_eq!(Error::StreamLimitExceeded as u32, 11);
    assert_eq!(Error::SelfStream as u32, 12);
    assert_eq!(Error::AlreadyInitialized as u32, 13);
    assert_eq!(Error::NonceTooLow as u32, 14);
    assert_eq!(Error::NonceOutOfOrder as u32, 15);
    assert_eq!(Error::RecipientTrustlineMissing as u32, 16);
    assert_eq!(Error::FeeTooHigh as u32, 17);
    assert_eq!(Error::InvalidFeeBps as u32, 18);
    assert_eq!(Error::SweepNoFees as u32, 19);
    assert_eq!(Error::SweepAmountMismatch as u32, 20);
    assert_eq!(Error::AdminCooldown as u32, 21);
}

/// All discriminants from `1` to `21` must be assigned and contiguous.
///
/// A gap or duplicate would break the monotonic code sequence expected
/// by backend error mappers.
#[test]
fn err_discriminants_are_contiguous_from_1_to_21() {
    let expected: [u32; 21] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ];
    let actual: [u32; 21] = [
        Error::NotFound as u32,
        Error::Unauthorized as u32,
        Error::ContractPaused as u32,
        Error::InvalidAmount as u32,
        Error::InvalidTimeRange as u32,
        Error::InvalidState as u32,
        Error::OverWithdraw as u32,
        Error::AlreadySettled as u32,
        Error::TokenNotAllowed as u32,
        Error::Overflow as u32,
        Error::StreamLimitExceeded as u32,
        Error::SelfStream as u32,
        Error::AlreadyInitialized as u32,
        Error::NonceTooLow as u32,
        Error::NonceOutOfOrder as u32,
        Error::RecipientTrustlineMissing as u32,
        Error::FeeTooHigh as u32,
        Error::InvalidFeeBps as u32,
        Error::SweepNoFees as u32,
        Error::SweepAmountMismatch as u32,
        Error::AdminCooldown as u32,
    ];
    assert_eq!(actual, expected);
}

/// Round-trip conversion from [`Error`] → [`u32`] → [`Error`] must succeed
/// for every variant.
///
/// The Soroban SDK's `#[contracterror]` derive implements conversions so
/// that the host can serialise and deserialise error codes.  This test
/// validates that every declared discriminant round-trips losslessly.
#[test]
fn err_conversion_roundtrip() {
    let variants = [
        Error::NotFound,
        Error::Unauthorized,
        Error::ContractPaused,
        Error::InvalidAmount,
        Error::InvalidTimeRange,
        Error::InvalidState,
        Error::OverWithdraw,
        Error::AlreadySettled,
        Error::TokenNotAllowed,
        Error::Overflow,
        Error::StreamLimitExceeded,
        Error::SelfStream,
        Error::AlreadyInitialized,
        Error::NonceTooLow,
        Error::NonceOutOfOrder,
        Error::RecipientTrustlineMissing,
        Error::FeeTooHigh,
        Error::InvalidFeeBps,
        Error::SweepNoFees,
        Error::SweepAmountMismatch,
        Error::AdminCooldown,
        Error::CooloffActive,
    ];

    for &variant in &variants {
        let code: u32 = variant as u32;
        let converted_back =
            Error::try_from(code).expect("every valid error code should convert back");
        assert_eq!(converted_back, variant, "roundtrip failed for code {code}");
    }
}

/// Converting an invalid [`u32`] value (one that does not match any
/// [`Error`] variant) via [`TryFrom<u32>`] must fail.
#[test]
fn err_invalid_code_conversion_fails() {
    // The valid range is 1..=22, so values outside that range are invalid.
    assert!(Error::try_from(0_u32).is_err());
    assert!(Error::try_from(23_u32).is_err());
    assert!(Error::try_from(u32::MAX).is_err());
}

/// Every [`Error`] variant survives XDR round-trip serialisation through
/// the Soroban host environment, confirming that `#[contracterror]`'s
/// encoding is stable.
#[test]
fn err_xdr_roundtrip_via_soroban_env() {
    let env = Env::default();

    let variants = [
        Error::NotFound,
        Error::Unauthorized,
        Error::ContractPaused,
        Error::InvalidAmount,
        Error::InvalidTimeRange,
        Error::InvalidState,
        Error::OverWithdraw,
        Error::AlreadySettled,
        Error::TokenNotAllowed,
        Error::Overflow,
        Error::StreamLimitExceeded,
        Error::SelfStream,
        Error::AlreadyInitialized,
        Error::NonceTooLow,
        Error::NonceOutOfOrder,
        Error::RecipientTrustlineMissing,
        Error::FeeTooHigh,
        Error::InvalidFeeBps,
        Error::SweepNoFees,
        Error::SweepAmountMismatch,
        Error::AdminCooldown,
    ];

    for &variant in &variants {
        let xdr_bytes = env.to_xdr(&variant);
        let deserialized: Error = env.from_xdr(&xdr_bytes);
        assert_eq!(deserialized, variant, "XDR roundtrip failed");
    }
}
