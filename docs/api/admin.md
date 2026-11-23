# Admin API Reference

This document covers all administrative HTTP endpoints under `app/api/admin/`, their authorization mechanisms, error envelopes, and audit-logging behavior.

## Table of Contents

- [Authorization](#authorization)
- [Error Envelopes](#error-envelopes)
- [Audit Logging](#audit-logging)
- [Endpoints](#endpoints)
  - [GET / POST `/api/admin/pause`](#get--post-apiadminpause)
  - [POST `/api/admin/pause-by-sender`](#post-apiadminpause-by-sender)
  - [GET / POST `/api/admin/circuit-breaker`](#get--post-apiadmincircuit-breaker)
  - [GET / POST `/api/admin/quotas`](#get--post-apiadminquotas)
  - [GET / PUT / DELETE `/api/admin/quotas/[id]`](#get--put--delete-apiadminquotasid)
  - [GET `/api/admin/jobs`](#get-apiadminjobs)
  - [POST `/api/admin/rotate`](#post-apiadminrotate)
  - [GET / POST `/api/admin/upgrade`](#get--post-apiadminupgrade)
  - [GET `/api/admin/streams/health`](#get-apiadminstreamshealth)
  - [POST `/api/admin/webhooks/redeliver`](#post-apiadminwebhooksredeliver)

---

## Authorization

Admin routes use one of two authorization mechanisms depending on whether the route is address-gated (mirroring Soroban contract admin checks) or ops/service-gated:

### 1. Admin Address Guard (`requireAdmin`)

Implemented in [`app/lib/admin-guard.ts`](../../app/lib/admin-guard.ts) and backed by [`app/lib/auth.ts`](../../app/lib/auth.ts).

1. **Caller resolution (`resolveCallerAddress`)**:
   - First inspects `Authorization: Bearer <token>` via `tryAuthenticateRequest(request)` (`app/lib/auth.ts`). Tokens must be signed with `HS256`, match `iss: "streampay"` and `aud: "streampay-api"`, have a non-empty `sub` (wallet address), and not have a revoked `jti` in the token denylist.
   - If no valid bearer token is present, falls back to the `Actor-Wallet-Address` request header.
2. **Admin comparison**:
   - Compares the resolved wallet address against the current admin address in `_state.adminAddress` (bootstrapped from `STREAMPAY_ADMIN_ADDRESS`, defaulting to `GADMIN_DEV_PLACEHOLDER_DO_NOT_USE_IN_PROD` in `development`/`test` when unset).
3. **Failure response**:
   - Returns HTTP `403` with `{ "error": { "code": "Unauthorized", "message": "..." } }` if no caller identity is resolved or if the caller does not match the current admin address.
   - Note: `GET /api/admin/streams/health` wraps `requireAdmin` failures into HTTP `403` with code `FORBIDDEN` and `request_id`.

Used by: `POST /api/admin/pause`, `POST /api/admin/pause-by-sender`, `GET / POST /api/admin/circuit-breaker`, `GET / POST /api/admin/quotas`, `GET / PUT / DELETE /api/admin/quotas/[id]`, `POST /api/admin/rotate`, `POST /api/admin/upgrade`, and `GET /api/admin/streams/health`.

> **Public read views:** `GET /api/admin/pause` and `GET /api/admin/upgrade` return `getAdminState()` without an auth check (mirroring the public `is_paused()` / instance state view on the contract).

### 2. Internal-Service HMAC Auth or Admin JWT

Used by ops endpoints that must sit behind an internal network boundary or API gateway rule in production:

1. Checks `requireInternalServiceAuth(request, { concealFailure: false })` (see [`docs/internal-service-auth.md`](../internal-service-auth.md)).
2. If internal HMAC auth does not succeed, falls back to `tryAuthenticateRequest(request)` (`app/lib/auth.ts`) and requires `actor.role === "admin"`.
3. If both fail, returns HTTP `401` (`INTERNAL_AUTH_REQUIRED`).

Used by: `GET /api/admin/jobs` and `POST /api/admin/webhooks/redeliver`.

---

## Error Envelopes

Error responses use one of two JSON envelopes depending on the route:

- **Standard envelope** (`pause`, `circuit-breaker`, `quotas`, `quotas/[id]`, `rotate`, `upgrade`, and direct `requireAdmin` 403 responses):
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Human-readable explanation"
    }
  }
  ```
- **Correlated envelope** (`pause-by-sender`, `jobs`, `streams/health`, `webhooks/redeliver`):
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Human-readable explanation",
      "request_id": "req-..."
    }
  }
  ```

---

## Audit Logging

Privileged mutating admin actions are appended to the tamper-evident audit log via `recordPrivilegedStreamAuditEvent` in [`app/lib/audit-log.ts`](../../app/lib/audit-log.ts). Each entry captures the actor, action name, before/after state hashes, request ID, request fingerprint metadata, and hash-chain links.

Recorded admin action names:
- `admin.pause.activate` / `admin.pause.lift` (`POST /api/admin/pause`)
- `admin.pause-by-sender` (`POST /api/admin/pause-by-sender`)
- `admin.circuit-breaker.<target>.trip` / `admin.circuit-breaker.<target>.reset` (`POST /api/admin/circuit-breaker`)
- `admin.quota.upsert` (`POST /api/admin/quotas`)
- `admin.quota.update` / `admin.quota.delete` (`PUT / DELETE /api/admin/quotas/[id]`)
- `admin.rotate` (`POST /api/admin/rotate`)
- `admin.upgrade.schedule` / `admin.upgrade.cancel` / `admin.upgrade.execute` (`POST /api/admin/upgrade`)

See [`docs/audit-log.md`](../audit-log.md) for retention, access control, export redaction, and hash-chain details.

---

## Endpoints

### GET / POST `/api/admin/pause`

Toggle or inspect the global pause circuit breaker. When `paused` is `true`, `create_stream` and `withdraw` are rejected with HTTP `503` (`ContractPaused`), while `cancel`, `settle`, and read operations remain available.

- **Auth:** `GET` is unauthenticated; `POST` requires `requireAdmin`.
- **Audit action:** `admin.pause.activate` or `admin.pause.lift`.

#### Request (`POST`)

```json
{
  "paused": true
}
```

#### Response (`200 OK` for `GET` and `POST`)

Returns `{ "data": AdminState }`:

```json
{
  "data": {
    "adminAddress": "G...",
    "paused": true,
    "pausedAt": "2026-07-30T12:00:00.000Z",
    "adminRotatedAt": null,
    "pendingUpgrade": null,
    "circuitBreakers": {
      "indexer": { "open": false, "updatedAt": null, "updatedBy": null },
      "webhook": { "open": false, "updatedAt": null, "updatedBy": null }
    }
  }
}
```

#### Error Codes (`POST`)

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `INVALID_REQUEST` | Request body is not valid JSON |
| `422` | `VALIDATION_ERROR` | Body does not contain `{ paused: boolean }` |
| `403` | `Unauthorized` | Caller is missing or not the current admin |

---

### POST `/api/admin/pause-by-sender`

Emergency-pause all `active` streams belonging to a specific sender address. Streams in non-active states are skipped.

- **Auth:** `requireAdmin`.
- **Audit action:** `admin.pause-by-sender` (recorded once per paused stream).
- **Error envelope:** Correlated (`request_id` included for 400/422; `requireAdmin` 403 uses standard envelope).

#### Request

```json
{
  "senderAddress": "G..."
}
```

#### Response (`200 OK`)

```json
{
  "data": {
    "paused": [ /* updated Stream objects */ ],
    "count": 2,
    "senderAddress": "G..."
  }
}
```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `Unauthorized` | Caller is missing or not the current admin |
| `400` | `INVALID_REQUEST` | Request body is not valid JSON |
| `422` | `VALIDATION_ERROR` | Missing or empty `senderAddress` string |

---

### GET / POST `/api/admin/circuit-breaker`

Read or toggle per-subsystem circuit breakers (`indexer` or `webhook`).

For full operational semantics, deferral vs. DLQ behavior, and multi-instance caveats, see [`docs/admin-circuit-breaker.md`](../admin-circuit-breaker.md).

- **Auth:** `requireAdmin` for both `GET` and `POST`.
- **Audit action:** `admin.circuit-breaker.<target>.trip` or `admin.circuit-breaker.<target>.reset`.

#### Request (`POST`)

```json
{
  "target": "webhook",
  "open": true
}
```

#### Response (`200 OK` for `GET` and `POST`)

```json
{
  "data": {
    "indexer": { "open": false, "updatedAt": null, "updatedBy": null },
    "webhook": { "open": true, "updatedAt": "2026-07-30T12:00:00.000Z", "updatedBy": "G..." }
  }
}
```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `INVALID_REQUEST` | Request body is not valid JSON (`POST`) |
| `422` | `VALIDATION_ERROR` | Missing/invalid `target` (`"indexer"` \| `"webhook"`) or non-boolean `open` (`POST`) |
| `403` | `Unauthorized` | Caller is missing or not the current admin (`GET`, `POST`) |

---

### GET / POST `/api/admin/quotas`

List all org/user quotas (`GET`) or create/upsert a quota for a `(scope, subject)` pair (`POST`).

- **Auth:** `requireAdmin` for both `GET` and `POST`.
- **Audit action:** `admin.quota.upsert` (`POST`).

#### Request (`POST`)

```json
{
  "scope": "org",
  "subject": "G...",
  "maxActiveStreams": 50,
  "maxMonthlyVolumeStroops": 1000000000
}
```

`maxActiveStreams` and `maxMonthlyVolumeStroops` are optional non-negative numbers (`0` means unlimited).

#### Response

- `GET` (`200 OK`): `{ "data": Quota[] }` (newest first).
- `POST` (`201 Created`): `{ "data": Quota }`:
  ```json
  {
    "data": {
      "id": "quota-...",
      "scope": "org",
      "subject": "G...",
      "maxActiveStreams": 50,
      "maxMonthlyVolumeStroops": 1000000000,
      "createdAt": "2026-07-30T12:00:00.000Z",
      "updatedAt": "2026-07-30T12:00:00.000Z"
    }
  }
  ```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `Unauthorized` | Caller is missing or not the current admin (`GET`, `POST`) |
| `400` | `INVALID_REQUEST` | Request body is not valid JSON (`POST`) |
| `422` | `VALIDATION_ERROR` | Invalid `scope` (`"org"` \| `"user"`), missing `subject`, or negative numeric limit (`POST`) |

---

### GET / PUT / DELETE `/api/admin/quotas/[id]`

Read (`GET`), fully replace (`PUT`), or delete (`DELETE`) a single quota by ID.

- **Auth:** `requireAdmin` for `GET`, `PUT`, and `DELETE`.
- **Audit action:** `admin.quota.update` (`PUT`), `admin.quota.delete` (`DELETE`).

#### Request (`PUT`)

Same body schema as `POST /api/admin/quotas`:

```json
{
  "scope": "user",
  "subject": "G...",
  "maxActiveStreams": 10,
  "maxMonthlyVolumeStroops": 0
}
```

#### Response

- `GET` (`200 OK`): `{ "data": Quota }`
- `PUT` (`200 OK`): `{ "data": Quota }`
- `DELETE` (`204 No Content`): empty body

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `Unauthorized` | Caller is missing or not the current admin (`GET`, `PUT`, `DELETE`) |
| `404` | `NOT_FOUND` | No quota exists with the given `id` (`GET`, `PUT`, `DELETE`) |
| `400` | `INVALID_REQUEST` | Request body is not valid JSON (`PUT`) |
| `422` | `VALIDATION_ERROR` | Invalid `scope`, missing `subject`, or negative numeric limit (`PUT`) |

---

### GET `/api/admin/jobs`

Return a snapshot of queued and dead-lettered background jobs across `settlement-queue`, `webhook-queue`, and `retry-queue`.

- **Auth:** Internal-service HMAC auth OR valid JWT with `role === "admin"`.
- **Error envelope:** Correlated (`request_id` included).

#### Response (`200 OK`)

```json
{
  "data": {
    "queues": {
      "settlement-queue": {
        "count": 1,
        "capacity": 1000,
        "deadLettered": 0,
        "jobs": [
          {
            "id": "job-...",
            "queueName": "settlement-queue",
            "attempts": 0,
            "maxAttempts": 3,
            "createdAt": "2026-07-30T12:00:00.000Z",
            "failed": false,
            "correlationId": null
          }
        ],
        "deadLetters": []
      },
      "webhook-queue": { "count": 0, "capacity": 1000, "deadLettered": 0, "jobs": [], "deadLetters": [] },
      "retry-queue": { "count": 0, "capacity": 1000, "deadLettered": 0, "jobs": [], "deadLetters": [] }
    },
    "totals": {
      "total": 1,
      "pending": 1,
      "failed": 0,
      "deadLettered": 0
    }
  }
}
```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `INTERNAL_AUTH_REQUIRED` | Missing/invalid internal-service signature and no valid `admin` JWT |

---

### POST `/api/admin/rotate`

Rotate the active admin wallet address to a new non-empty address (the admin address can never be zeroed).

- **Auth:** `requireAdmin` (via `setAdmin` in `app/lib/admin-guard.ts`).
- **Audit action:** `admin.rotate`.

#### Request

```json
{
  "newAdmin": "GNEWADMIN..."
}
```

#### Response (`200 OK`)

Returns `{ "data": AdminState }` with the updated `adminAddress` and `adminRotatedAt` timestamp.

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `INVALID_REQUEST` | Request body is not valid JSON |
| `422` | `VALIDATION_ERROR` | Body does not contain a non-empty `{ newAdmin: string }` |
| `403` | `Unauthorized` | Caller is missing or not the current admin |
| `400` | `Unauthorized` | `newAdmin` is empty after trimming (defensive guard in `setAdmin`) |

---

### GET / POST `/api/admin/upgrade`

Inspect (`GET`) or manage (`POST`) the two-step contract upgrade timelock (48-hour delay between `schedule` and `execute`).

- **Auth:** `GET` is unauthenticated; `POST` requires `requireAdmin` (via `scheduleUpgrade`, `cancelUpgrade`, `executeUpgrade` in `app/lib/admin-guard.ts`).
- **Audit action:** `admin.upgrade.schedule`, `admin.upgrade.cancel`, or `admin.upgrade.execute`.

#### Request (`POST`)

- **Schedule an upgrade** (starts 48h timelock; only one pending upgrade allowed at a time):
  ```json
  { "action": "schedule", "data": "wasm-hash-or-config" }
  ```
- **Cancel a pending upgrade**:
  ```json
  { "action": "cancel" }
  ```
- **Execute a scheduled upgrade** (only succeeds once `executableAt` has passed):
  ```json
  { "action": "execute" }
  ```

#### Response (`200 OK` for `GET` and `POST`)

Returns `{ "data": AdminState }`, including `pendingUpgrade`:

```json
{
  "data": {
    "adminAddress": "G...",
    "paused": false,
    "pausedAt": null,
    "adminRotatedAt": null,
    "pendingUpgrade": {
      "id": "upgrade-...",
      "data": "wasm-hash-or-config",
      "scheduledAt": "2026-07-30T12:00:00.000Z",
      "executableAt": "2026-08-01T12:00:00.000Z",
      "executedAt": null,
      "cancelledAt": null
    },
    "circuitBreakers": {
      "indexer": { "open": false, "updatedAt": null, "updatedBy": null },
      "webhook": { "open": false, "updatedAt": null, "updatedBy": null }
    }
  }
}
```

#### Error Codes (`POST`)

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `INVALID_REQUEST` | Request body is not valid JSON |
| `422` | `VALIDATION_ERROR` | Missing/unknown `action`, or `schedule` missing string `data` |
| `403` | `Unauthorized` | Caller is missing or not the current admin |
| `400` | `InvalidRequest` | `schedule` `data` is empty after trimming |
| `409` | `UpgradeAlreadyScheduled` | Another pending upgrade is already scheduled (`schedule`) |
| `400` | `NoUpgradeScheduled` | No pending upgrade exists to cancel or execute (`cancel`, `execute`) |
| `400` | `UpgradeCancelled` | Pending upgrade was already cancelled (`execute`) |
| `400` | `UpgradeAlreadyExecuted` | Pending upgrade was already executed (`execute`) |
| `400` | `TimelockNotExpired` | 48-hour timelock has not yet elapsed (`execute`) |

---

### GET `/api/admin/streams/health`

Return aggregated health metrics for the streams subsystem.

- **Auth:** `requireAdmin` (failures are mapped to `403 FORBIDDEN`).
- **Error envelope:** Correlated (`request_id` included).

#### Response (`200 OK`)

```json
{
  "data": {
    "health": {
      "total": 42,
      "byStatus": {
        "active": 35,
        "paused": 5,
        "errored": 2
      },
      "failureRatePct": 4.76,
      "oldestStuckAt": "2026-07-29T08:15:00.000Z",
      "checkedAt": "2026-07-30T12:00:00.000Z"
    }
  }
}
```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `FORBIDDEN` | Caller is missing or not the current admin |
| `500` | `INTERNAL_SERVER_ERROR` | Data store unavailable or unexpected error |

---

### POST `/api/admin/webhooks/redeliver`

Force-redeliver a webhook event by its original `deliveryId`, creating a new delivery record while preserving the original audit trail. Deliveries recorded before full event/endpoint snapshots were introduced cannot be redelivered here — use `POST /api/webhooks/dlq/:dlqId/replay` instead.

- **Auth:** Internal-service HMAC auth OR valid JWT with `role === "admin"`.
- **Error envelope:** Correlated (`request_id` included).

#### Request

```json
{
  "deliveryId": "del-..."
}
```

#### Response (`200 OK`)

```json
{
  "data": {
    "deliveryId": "del-new-...",
    "originalDeliveryId": "del-..."
  },
  "links": {
    "delivery": "/api/webhooks/deliveries?delivery_id=del-new-..."
  }
}
```

#### Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `INTERNAL_AUTH_REQUIRED` | Missing/invalid internal-service signature and no valid `admin` JWT |
| `400` | `INVALID_REQUEST_BODY` | Request body is not valid JSON |
| `400` | `VALIDATION_ERROR` | Missing or empty `deliveryId` |
| `404` | `DELIVERY_NOT_FOUND` | No delivery found for `deliveryId` |
| `400` | `DELIVERY_NO_SNAPSHOT` | Delivery exists but lacks stored event/endpoint snapshot data |
