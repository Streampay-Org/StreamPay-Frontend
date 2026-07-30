//! # Withdrawer allowlist authorization
//!
//! This module enforces the per-stream withdrawer allowlist introduced in
//! issue #607. It provides a single entry-point, [`require_withdraw_auth`],
//! that is called from [`crate::Contract::withdraw`] in place of the
//! previous unconditional `recipient.require_auth()`.
//!
//! ## Authorization rules
//!
//! A withdrawal is authorized when **either** condition holds:
//!
//! 1. `caller == stream.recipient` — the recipient always retains the right
//!    to withdraw their own vested funds.
//! 2. `caller` is present in the per-stream withdrawer allowlist — an address
//!    that the *sender* has explicitly granted withdrawal rights.
//!
//! In both cases the Soroban host `require_auth` check is performed against
//! `caller`, so the transaction must carry a valid signature for that address.
//! If neither condition is satisfied the call returns [`Error::Unauthorized`].
//!
//! ## Allowlist management
//!
//! The allowlist is managed via [`crate::Contract::add_withdrawer`] and
//! [`crate::Contract::remove_withdrawer`], which are gated behind the
//! stream sender's authorization.

use crate::error::Error;
use crate::storage;
use soroban_sdk::{Address, Env};

/// Authorizes a withdrawal by `caller` against `stream_id`.
///
/// The call succeeds if `caller` is the stream recipient or is present in the
/// per-stream withdrawer allowlist. `caller.require_auth()` is invoked so the
/// Soroban host enforces a valid transaction signature.
///
/// # Errors
/// - [`Error::Unauthorized`] if `caller` is neither the recipient nor an
///   allowlisted withdrawer.
pub fn require_withdraw_auth(
    env: &Env,
    stream_id: u64,
    caller: &Address,
    recipient: &Address,
) -> Result<(), Error> {
    if caller == recipient || storage::is_withdrawer_allowed(env, stream_id, caller) {
        caller.require_auth();
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
