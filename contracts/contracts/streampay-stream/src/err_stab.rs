#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

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
}

#[test]
fn err_discriminants_are_contiguous_from_1_to_18() {
    let expected: [u32; 18] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ];
    let actual: [u32; 18] = [
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
    ];
    assert_eq!(actual, expected);
}

#[test]
fn err_discriminants_from_19_to_22_are_stable() {
    assert_eq!(Error::SweepNoFees as u32, 19);
    assert_eq!(Error::SweepAmountMismatch as u32, 20);
    assert_eq!(Error::AdminCooldown as u32, 21);
    assert_eq!(Error::CooloffActive as u32, 22);
}
