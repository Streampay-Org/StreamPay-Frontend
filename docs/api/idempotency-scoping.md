# Idempotency scoping for stream lifecycle routes

`POST /api/streams/:id/settle` and `POST /api/streams/:id/withdraw` accept an
`Idempotency-Key` header. A retry with the same key must not settle or withdraw
twice, and it must never return the cached response of a *different* stream.

## What is stored

| Field | Value |
| --- | --- |
| Storage key | `idempotency:<namespace>:<len>:<stream id>:<Idempotency-Key>` |
| Fingerprint | `SHA-256(key, route, stream id, actor wallet, SHA-256(body))` |
| TTL | 24 hours (`IDEMPOTENCY_TTL_MS`) |

`<namespace>` is `settle` or `withdraw`. The stream id is length-prefixed so that
no combination of stream id and client key can collide with another pair.

## Rules

1. **The record is bound to the stream.** The stream id is part of the storage
   key, so `Idempotency-Key: settle-2026-01-01` used on stream A and then on
   stream B stores two independent records. Stream B is settled; it never
   receives stream A's cached response.
2. **The record is bound to the caller.** When the request carries an
   `Actor-Wallet-Address`, that address is part of the fingerprint. The same
   key replayed by a different wallet is answered with `409 IdempotencyKeyReused`
   instead of the original response.
3. **A different body is a conflict.** The same key with a different request
   body is answered with `409 IdempotencyKeyReused`.
4. **A missing or malformed key is rejected.** A missing key returns
   `400 IdempotencyKeyRequired`; a key that is not 1-255 printable ASCII
   characters returns `400 IdempotencyKeyInvalid`.

## Responses

| Situation | Status | `Idempotency-Replay` |
| --- | --- | --- |
| First call | route status | `false` |
| Identical retry | cached status | `true` |
| Same key, different body or caller | `409` | not set |
| Missing key | `400` | not set |

## Notes

The v1 routes (`start`, `stop`, `cancel`) already scoped their token with
`idempotencyToken("streams.<action>.<stream id>", key)`. Settle and withdraw now
carry the same guarantee through `withIdempotency`.
