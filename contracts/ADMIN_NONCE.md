# Admin Nonce — Feature Notes (issue #949)

## What changed

Two new contract entrypoints and the supporting infrastructure for
replay-preventing, privileged stream overrides.

### New entrypoints

| Entrypoint | Auth | Description |
|---|---|---|
| `get_admin_nonce() → u64` | None | Returns the next nonce the admin must supply to `admin_override`. Read-only. |
| `admin_override(admin, nonce, stream_id, new_end_time) → Stream` | Admin | Overrides a stream's `end_time`. Consumes `nonce` on success. |

### New error codes

| Code | Discriminant | Meaning |
|---|---|---|
| `NonceTooLow` | 14 | `nonce < stored_nonce` — replayed or stale nonce. |
| `NonceOutOfOrder` | 15 | `nonce > stored_nonce` — gap in the monotonic sequence. |

`RecipientTrustlineMissing = 16` was already referenced in `lib.rs` but
missing from `error.rs`; it has been added to keep the enum consistent with
existing usage.

## Design rationale

Soroban's native authorisation mechanism is non-replayable *within a ledger
sequence*: an auth token is bound to a specific ledger range and cannot be
submitted twice. However, long-lived admin workflows (e.g. off-chain key
management, multisig flows, governance queues) can produce signed
authorisations that outlive a single ledger window. A monotonic nonce adds a
**cross-ledger, cross-session replay fence** on top of the native mechanism.

The nonce:
- Is stored in **instance storage** (same TTL cadence as the admin key).
- Starts at `0` on a freshly deployed contract.
- Must be provided as the *current* stored value; the call increments it to
  `current + 1` before any other mutation, so a failed subsequent operation
  still consumes the nonce.
- Is intentionally a simple counter; no nonce hash or salt is needed because
  Soroban ledger auth already binds the message to the transaction.

## Security properties

1. **Replay prevention**: `provided_nonce == stored_nonce` is a strict
   precondition. A replayed transaction carries a nonce that is now `< stored`,
   so it fails with `NonceTooLow`.
2. **Gap prevention**: `provided_nonce > stored_nonce` fails with
   `NonceOutOfOrder`, preventing the admin from accidentally skipping nonces
   and leaving unused values that could be exploited in future.
3. **Auth-first**: `admin.require_auth()` is called before the nonce is
   consumed. An auth failure leaves the nonce unchanged.
4. **Narrow scope**: `admin_override` only permits changing `end_time`.
   Mutations to `total_amount`, `recipient`, or `sender` require separate
   governance paths.

## Migration / deployment

No storage migration is required. The `AdminNonce` key starts absent (treated
as `0`) and is written on the first `admin_override` call. Existing deployed
contracts acquire the new entrypoints transparently on upgrade via the existing
`Contract::upgrade` path.

## Usage example

```
# Query current nonce
nonce=$(stellar contract invoke … -- get_admin_nonce)

# Submit the override (nonce must match exactly)
stellar contract invoke … -- admin_override \
    --admin GADMIN… \
    --nonce "$nonce" \
    --stream_id 42 \
    --new_end_time 1800000000
```
