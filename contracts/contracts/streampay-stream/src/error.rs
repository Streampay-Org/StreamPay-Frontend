//! # Contract error codes
//!
//! Every error returned by the `StreamPay` contract is one of the
//! discriminants in [`Error`]. The backend maps these codes one-to-one
//! into the public Problem+JSON error envelope, so:
//!
//! - **Discriminants are part of the public contract API.** Do not
//!   reuse a discriminant after it has shipped; add new variants at
//!   the end of the enum instead.
//! - **Variant names are not part of the API.** Renaming a variant is
//!   safe as long as the numeric discriminant stays stable.
//! - **Backend mapping** lives in `app/lib/errors/`. Adding a new
//!   variant here requires a matching entry there.

use soroban_sdk::contracterror;

/// Stable `StreamPay` contract error codes for backend Problem+JSON mapping.
///
/// Discriminants are part of the public contract API and must not be reused.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// 1: Requested stream or storage record was not found.
    NotFound = 1,
    /// 2: Caller is not authorized for the requested operation.
    Unauthorized = 2,
    /// 3: Contract-level pause guard blocked the operation.
    ContractPaused = 3,
    /// 4: Amount is zero, negative, or otherwise invalid.
    InvalidAmount = 4,
    /// 5: Time range or duration is invalid.
    InvalidTimeRange = 5,
    /// 6: Stream state does not allow the requested transition.
    InvalidState = 6,
    /// 7: Withdrawal exceeds currently accrued funds.
    OverWithdraw = 7,
    /// 8: Stream has already been fully settled.
    AlreadySettled = 8,
    /// 9: Token is not allowed for streaming.
    TokenNotAllowed = 9,
    /// 10: Arithmetic overflow in amount calculation.
    Overflow = 10,
    /// 11: Sender has exceeded the maximum number of active streams.
    StreamLimitExceeded = 11,
    /// 12: Stream sender and recipient are the same address.
    SelfStream = 12,
    /// 13: Contract has already been initialised.
    AlreadyInitialized = 13,
    /// 14: Provided admin nonce is lower than the stored counter (stale / replayed).
    NonceTooLow = 14,
    /// 15: Provided admin nonce is higher than the stored counter (out-of-order gap).
    NonceOutOfOrder = 15,
    /// 16: Recipient does not have a trustline for the token.
    RecipientTrustlineMissing = 16,
    /// 17: Protocol fee exceeds the caller's `max_fee_bps` slippage guard.
    FeeTooHigh = 17,
    /// 18: Fee basis points value exceeds the maximum allowed (10 000).
    InvalidFeeBps = 18,
    /// 19: No accumulated fees are available to sweep (all per-stream balances are zero).
    SweepNoFees = 19,
    /// 20: Accumulated fee balance for a stream underflows or would produce an
    ///     invalid token transfer amount.  Guards against integer manipulation.
    SweepAmountMismatch = 20,
    /// 21: Admin action is currently in cooldown.
    AdminCooldown = 21,
    /// 22: Sender is in cooloff period and cannot create a new stream yet.
    CooloffActive = 22,
}
