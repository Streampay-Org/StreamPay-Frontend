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
//! * The discriminants form a contiguous block from `1` to `30`.
//! * Round-trip [`Error`] -> [`InvokeError`] -> [`Error`] conversion is lossless.
//!
//! ## When to update
//!
//! When adding a **new** variant, append a new assertion for it at the end
//! of each test and bump the contiguous-range check.  Never renumber or
//! delete an existing variant.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use soroban_sdk::InvokeError;
use streampay_stream::Error;

/// Every [`Error`] variant, in discriminant order.
const ALL_VARIANTS: [Error; 30] = [
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
    Error::AmountTooLarge,
    Error::NotDormant,
    Error::DormancyDisabled,
    Error::NoPendingTransfer,
    Error::InvalidSchedule,
    Error::InvalidDuration,
    Error::AmountTooSmall,
    Error::MemoTooLong,
];

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
    assert_eq!(Error::CooloffActive as u32, 22);
    assert_eq!(Error::AmountTooLarge as u32, 23);
    assert_eq!(Error::NotDormant as u32, 24);
    assert_eq!(Error::DormancyDisabled as u32, 25);
    assert_eq!(Error::NoPendingTransfer as u32, 26);
    assert_eq!(Error::InvalidSchedule as u32, 27);
    assert_eq!(Error::InvalidDuration as u32, 28);
    assert_eq!(Error::AmountTooSmall as u32, 29);
    assert_eq!(Error::MemoTooLong as u32, 30);
}

/// All discriminants from `1` to `30` must be assigned and contiguous.
///
/// A gap or duplicate would break the monotonic code sequence expected
/// by backend error mappers.
#[test]
fn err_discriminants_are_contiguous() {
    for (index, variant) in ALL_VARIANTS.iter().enumerate() {
        let expected = index as u32 + 1;
        assert_eq!(
            *variant as u32,
            expected,
            "variant at index {index} has an unexpected discriminant"
        );
    }
}

/// Round-trip conversion from [`Error`] -> [`InvokeError`] -> [`Error`] must
/// succeed for every variant.
///
/// `#[contracterror]` derives the `InvokeError` conversions the host uses to
/// carry contract error codes across the host boundary. This test validates
/// that every declared discriminant round-trips losslessly.
#[test]
fn err_conversion_roundtrip() {
    for &variant in ALL_VARIANTS.iter() {
        let code: u32 = variant as u32;
        let as_invoke_error: InvokeError = variant.into();
        let converted_back =
            Error::try_from(&as_invoke_error).expect("every valid error code should convert back");
        assert_eq!(converted_back, variant, "roundtrip failed for code {code}");
    }
}
