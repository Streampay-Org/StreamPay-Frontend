# Wallet Auth Input Validation

`GET /api/auth/wallet` and `POST /api/auth/wallet` validate input at the
boundary with Zod schemas (`app/lib/auth-wallet-validation.ts`) before any
other processing.

## GET /api/auth/wallet

Issues a one-time challenge for wallet-based authentication. Challenges are
generated with a CSPRNG and have the shape
`streampay-auth:v1:<nonce>|<origin>|<expires_at>`, where `<nonce>` is a
43-character base64url value, `<origin>` is the server origin, and
`<expires_at>` is the ISO-8601 expiry. The client signs the whole string, so a
challenge minted on one deployment cannot be replayed against another.

| Query param | Rules |
| ----------- | ----- |
| `address`   | Required for challenge issuance. Stellar public key, checksum-validated (strkey), not just shape. |
| `limit`     | Rejected with `400 UNSUPPORTED_QUERY`. |
| `cursor`    | Rejected with `400 UNSUPPORTED_QUERY`. |

The paginated listing mode was **removed** as a security fix: returning every
outstanding challenge let unauthenticated callers harvest live challenges for
any address. Responses always carry `Cache-Control: no-store` and never answer
`304 Not Modified` — a freshly issued challenge must reach the client. The
in-process store is bounded: 5 live challenges per address (oldest evicted),
`WALLET_CHALLENGE_MAX` globally (default 10 000), TTL-pruned on every write.

## POST /api/auth/wallet

Verifies the signed challenge (double-submit CSRF protected) and issues a
bearer token. CSRF and signature checks run only after the body passes
validation.

| Body field  | Rules |
| ----------- | ----- |
| `address`   | Required string. Checksum-valid Stellar public key. |
| `challenge` | Required string. Must match the issued shape `streampay-auth:v1:<nonce>|<origin>|<expires_at>`, max 256 chars. |
| `signature` | Required non-empty string, max 1024 chars. |

Unknown body fields are ignored. A body that is not valid JSON is rejected
with a `422` and an `INVALID_JSON` detail.

## Validation failures

Invalid input returns `422` with the standard envelope and per-field details,
the same shape `/api/streams` uses:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "details": [
      { "field": "address", "code": "CUSTOM", "message": "must be a valid Stellar public key." }
    ],
    "request_id": "req_..."
  }
}
```

Breaking change note: these endpoints previously returned `400 BAD_REQUEST`
for malformed input (and `500` for a non-JSON body); both now return `422`.

Rate limits are unchanged, see [rate-limits.md](../rate-limits.md).

## GET /api/auth/wallet/health

Health probe for the wallet-auth subsystem's runtime dependencies.

**No authentication or rate-limiting** is applied to this endpoint. It is
intended for infrastructure health probes (load balancers, Kubernetes
readiness checks, uptime monitors) and does not expose any sensitive data.

### Response

| Scenario | HTTP status | `status` field |
| -------- | ----------- | -------------- |
| All checks pass | `200 OK` | `"ok"` |
| Any check fails | `503 Service Unavailable` | `"degraded"` |

#### Body shape

```json
{
  "status": "ok",
  "checks": {
    "jwt_secret": {
      "status": "ok",
      "checked_at": "2026-07-25T17:00:00.000Z"
    },
    "config": {
      "status": "ok",
      "checked_at": "2026-07-25T17:00:00.000Z"
    },
    "challenge_store": {
      "status": "ok",
      "checked_at": "2026-07-25T17:00:00.000Z"
    }
  }
}
```

When a check is `"degraded"` a human-readable `message` field is added:

```json
{
  "status": "degraded",
  "checks": {
    "jwt_secret": {
      "status": "degraded",
      "message": "JWT_SECRET environment variable is required.",
      "checked_at": "2026-07-25T17:00:00.000Z"
    },
    ...
  }
}
```

### Checks

| Check | What is probed | Degrades when |
| ----- | -------------- | ------------- |
| `jwt_secret` | `JWT_SECRET` env var is present and `≥ 32` characters | Variable is absent, too short, or still set to the insecure dev placeholder |
| `config` | App configuration passes `validateConfig()` | `STELLAR_NETWORK`, `ALLOWED_ORIGINS`, or other required env vars are missing or invalid |
| `challenge_store` | The wallet-auth route module (and its in-process challenge store) can be loaded | Module resolution or import fails at runtime |

### Logging

Every invocation emits a structured `info`-level log entry including
`duration_ms`, `status`, `request_id`, and `correlation_id` for observability.

