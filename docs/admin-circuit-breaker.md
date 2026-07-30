# Admin Circuit Breaker

## Overview

The admin circuit breaker is an **operator-controlled kill switch** for the indexer and webhook subsystems. It is toggled manually via `POST /api/admin/circuit-breaker` and is intended for incident response — when a downstream is melting down, an operator trips the breaker to stop dispatch without deploying code.

## Two different things are called "circuit breaker"

This is the most important distinction in this document. They are independent mechanisms with opposite failure semantics.

| | Admin breaker | Per-endpoint breaker |
|---|---|---|
| Defined in | [`admin-guard.ts`](../app/lib/admin-guard.ts) | [`webhook-delivery.ts`](../app/lib/webhook-delivery.ts) |
| Trips | Manually, by an admin | Automatically, after 5 consecutive failures |
| Resets | Manually, by an admin | Automatically, after 5 minutes |
| Scope | Whole subsystem | One endpoint |
| Effect on events | **Held (deferred)** | **Sent to DLQ** |

The reason the effects differ: when a *single endpoint* fails repeatedly, that endpoint is broken and its events belong in the DLQ for later inspection. When an *operator* pauses the whole subsystem, nothing is broken on the customer side — DLQing every in-flight event would turn a deliberate pause into mass event loss. So the admin breaker defers.

The admin breaker is checked **first**, before any endpoint-specific logic, and deferral does **not** count as a failure against the endpoint. This matters: without that, ten deferrals during a pause would trip the per-endpoint breaker too, and traffic would not resume cleanly when the admin reset the global one.

## API

### Trip a breaker

```http
POST /api/admin/circuit-breaker
Actor-Wallet-Address: G...ADMIN
Content-Type: application/json

{ "target": "webhook", "open": true }
```

### Read current state

```http
GET /api/admin/circuit-breaker
Actor-Wallet-Address: G...ADMIN
```

```json
{
  "data": {
    "indexer": { "open": false, "updatedAt": null, "updatedBy": null },
    "webhook": { "open": true,  "updatedAt": "2026-07-30T12:00:00.000Z", "updatedBy": "G...ADMIN" }
  }
}
```

`target` must be `indexer` or `webhook`; `open` must be a boolean. Both handlers are gated by admin auth and every toggle is written to the privileged audit log.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Body is not valid JSON |
| `VALIDATION_ERROR` | 422 | Missing/invalid `target` or `open` |
| `Unauthorized` | 403 | Caller is not the admin |

## What each target actually does

### `webhook`

Enforced in the dispatch path. While open:

- `attemptDelivery` returns `{ deferred: true }` without making any outbound HTTP request.
- `processDelivery` returns `{ deferred: true }` and does **not** move the delivery to the DLQ.
- `processOutboxEntry` returns the entry to `pending` status, so it is retried later.
- `drainOutbox` skips the drain entirely, rather than churning every pending entry through a deferral each tick.

Events accumulate in the outbox and flow normally once the breaker is reset.

### `indexer`

Surfaced on `GET /api/indexer/status` as the `breakerOpen` field, so operators and dashboards can see that ingestion is paused.

> **Note:** this repo does not currently contain a real indexer ingestion loop — [`app/api/indexer/status/route.ts`](../app/api/indexer/status/route.ts) returns mocked cursor/lag values. When a real ingestion worker lands, it should call `isCircuitBreakerOpen("indexer")` at the top of its poll loop, following the webhook pattern above.

## Operational notes

**State is in-memory.** Breaker state lives in the `_state` singleton in `admin-guard.ts`. It resets to closed on process restart and is **not shared across instances** — in a multi-instance deployment, tripping the breaker affects only the instance that served the request. Moving this to shared storage (Redis or Postgres) is required before relying on it in a horizontally-scaled production environment.

**Reset is not automatic.** Unlike the per-endpoint breaker, nothing re-closes the admin breaker on a timer. It stays open until an admin explicitly sets `open: false`. Pair tripping it with an alert so a pause is never forgotten.

## Tests

Enforcement is covered by [`app/lib/webhook-circuit-breaker.test.ts`](../app/lib/webhook-circuit-breaker.test.ts) — no outbound HTTP while open, no DLQ on defer, no endpoint-failure recording on defer, outbox entries stay retryable, drain skipping, target independence, and normal delivery after reset. Endpoint auth/validation is covered by [`app/api/admin/circuit-breaker/route.test.ts`](../app/api/admin/circuit-breaker/route.test.ts).
