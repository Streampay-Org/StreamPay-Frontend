# Structured Access Logs — /api/exports (v7)

**Issue:** GrantFox FWC26 Campaign (Stellar Wave)  
**Branch:** `task/exports-logs-v7`

---

## Overview

`POST /api/exports` and `GET /api/exports` now emit a **structured access-log entry** for every request, regardless of the response status code (200, 201, 304, 401, 429, 500, …).

Log entries are written via `logAccessEvent` (see `src/middleware/accessLog.ts`) to the same JSON logger used by the rest of the service (`app/lib/logger.ts`), so they appear in the same structured log stream and carry the active correlation context.

---

## Log fields

| Field | Type | Present when | Description |
|-------|------|-------------|-------------|
| `message` | string | Always | Fixed value `"http access"` |
| `method` | string | Always | HTTP verb: `"POST"` or `"GET"` |
| `path` | string | Always | Fixed value `"/api/exports"` |
| `status` | number | Always | HTTP response status code |
| `durationMs` | number | Always | Wall-clock time for the handler in milliseconds |
| `actorId` | string | Authenticated requests | Stellar wallet address of the caller |
| `exportJobId` | string | Successful POST | UUID of the newly-created export job |
| `errorCode` | string | Error responses | Machine-readable error code (e.g. `UNAUTHORIZED`, `RATE_LIMITED`, `INTERNAL_ERROR`) |
| `request_id` | string | Correlation context set | Forwarded from `x-request-id` or auto-generated |
| `correlation_id` | string | Correlation context set | From `x-correlation-id` or same as `request_id` |
| `traceparent` | string | W3C traceparent present | W3C trace context header value |

### Example — successful POST (201)

```json
{
  "level": "info",
  "message": "http access",
  "method": "POST",
  "path": "/api/exports",
  "status": 201,
  "durationMs": 12.4,
  "actorId": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGZWXSC3FVJLASHLZBXYGBMIP",
  "exportJobId": "550e8400-e29b-41d4-a716-446655440000",
  "request_id": "req_01HZ9ABCDEF",
  "correlation_id": "corr-abc-123",
  "timestamp": "2026-07-29T13:32:22.000Z",
  "service": "streampay-frontend",
  "environment": "production"
}
```

### Example — unauthenticated request (401)

```json
{
  "level": "info",
  "message": "http access",
  "method": "GET",
  "path": "/api/exports",
  "status": 401,
  "durationMs": 0.8,
  "errorCode": "UNAUTHORIZED",
  "request_id": "req_01HZ9XYZABC",
  "correlation_id": "req_01HZ9XYZABC",
  "timestamp": "2026-07-29T13:32:22.000Z",
  "service": "streampay-frontend",
  "environment": "production"
}
```

### Example — rate-limited request (429)

```json
{
  "level": "info",
  "message": "http access",
  "method": "POST",
  "path": "/api/exports",
  "status": 429,
  "durationMs": 2.1,
  "actorId": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGZWXSC3FVJLASHLZBXYGBMIP",
  "errorCode": "RATE_LIMITED",
  "request_id": "req_01HZ9LMNOQR",
  "correlation_id": "corr-xyz-789",
  "timestamp": "2026-07-29T13:32:22.000Z",
  "service": "streampay-frontend",
  "environment": "production"
}
```

---

## Status codes covered

| Status | Scenario |
|--------|----------|
| 200 | `GET /api/exports` — list returned |
| 201 | `POST /api/exports` — job created |
| 304 | `GET /api/exports` — ETag match (no body) |
| 401 | Missing or invalid `Authorization` header |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |

---

## Implementation details

### `src/middleware/accessLog.ts`

The `logAccessEvent` function accepts an `AccessLogContext` object:

```typescript
export interface AccessLogContext {
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  actorId?: string;        // wallet address of authenticated caller
  exportJobId?: string;    // job UUID (POST only, on success)
  errorCode?: string;      // machine-readable code on error
  errorMessage?: string;   // human-readable description on error
  [key: string]: unknown;  // additional caller-supplied fields
}
```

- `actorId` is only included when the caller is authenticated.
- `exportJobId` is only included on a successful `POST` (201).
- `errorCode` is included on all error responses.
- `traceparent` is included only when the active correlation context carries a valid W3C traceparent value — it is never included for external/untrusted requests.
- All fields are safe to log: `actorId` contains only the Stellar wallet address (a public key), never secrets.

### `app/api/exports/route.ts`

Both `POST` and `GET` handlers:

1. Record `startedAt = process.hrtime()` at the beginning.
2. Track `actorId`, `exportJobId`, and `errorCode` in mutable local variables updated as the handler proceeds.
3. Call `logAccessEvent(...)` in the `finally` block, ensuring the access log is emitted even if an unexpected error is thrown.

---

## Visible / API changes

- No changes to request or response shape.
- No new headers.
- Additional structured log lines emitted on every request to `/api/exports` (POST and GET).

---

## Security notes

- `actorId` is the Stellar wallet address (a public key). It is not a secret and is safe to log.
- No passwords, JWT payloads, or private keys are included in access log entries.
- Secret redaction (`redactSecrets`) from `app/lib/logger.ts` applies to the underlying `logger.info` call before any output.
- `traceparent` is excluded from external requests (see `app/lib/correlation-middleware.ts` `sanitizeCorrelationHeaders`) to prevent trace spoofing.

---

## Verification

```bash
# Run the focused access-log middleware tests
npx jest src/middleware/accessLog.test.ts --no-coverage

# Run the route-level access-log integration tests
npx jest app/api/exports/exports.accessLog.test.ts --no-coverage

# Run the full exports test suite
npx jest app/api/exports/ --no-coverage

# Lint
npm run lint
```
