# Notification Preferences API

`GET` and `PUT` `/api/notifications/preferences` read and update the
authenticated user's notification settings. `PUT` supports optimistic
concurrency through the `ETag` and `If-Match` headers.

Source of truth: `app/api/notifications/preferences/route.ts`, with helpers in
`app/lib/etag.ts` and `app/lib/quiet-hours.ts`.

| Method | Path | Auth | Rate-limit bucket |
| ------ | ---- | ---- | ----------------- |
| `GET`  | `/api/notifications/preferences` | Bearer | `read` (60 requests / 60 s) |
| `PUT`  | `/api/notifications/preferences` | Bearer | `write` (10 requests / 60 s) |

---

## Authentication

Both methods call `tryAuthenticateRequest`, which reads
`Authorization: Bearer <token>`. The token is the one issued by
`POST /api/auth/wallet` (see [auth-wallet.md](auth-wallet.md)). Tokens whose
`jti` has been revoked are rejected.

A missing, malformed, expired or revoked token returns `401 UNAUTHORIZED`.
Preferences are stored per authenticated actor (`actorId`); there is no way to
read or write another user's preferences, and `userId` in the response is
always the caller's own `actorId`.

State-changing requests also pass through the global CSRF middleware. A request
that carries **no cookies** and authenticates with a bearer token is exempt.
A `PUT` that carries cookies must send a valid `x-csrf-token` header or it is
rejected with `403 CSRF_TOKEN_INVALID` before reaching the route.

## Rate limiting

The route resolves its bucket with `getLimitForRoute(method, path)`. There is no
dedicated entry for this path in `ROUTE_LIMITS`, so the defaults apply: `GET`
uses the `read` bucket (60 requests per minute) and `PUT` uses the `write`
bucket (10 requests per minute). The limit is checked **before**
authentication, so unauthenticated floods are throttled too.

When the limit is exceeded the response is `429` with
`error.code = "rate_limit_exceeded"` (lowercase, unlike every other code on this
route) and a `Retry-After` header in seconds.

---

## The `NotificationPreferences` object

| Field | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `userId` | string | caller's `actorId` | Read-only. Sending it in a `PUT` is rejected (`400`). |
| `email` | boolean | `true` | |
| `inApp` | boolean | `true` | |
| `webhook` | boolean | `false` | |
| `soundEnabled` | boolean | `true` | |
| `events.streamCreated` | boolean | `true` | |
| `events.streamCompleted` | boolean | `true` | |
| `events.streamCancelled` | boolean | `true` | |
| `events.paymentFailed` | boolean | `true` | |
| `events.lowBalance` | boolean | `false` | |
| `quietHours.enabled` | boolean | `false` | |
| `quietHours.startTime` | string `HH:mm` | `"22:00"` | 24-hour clock, inclusive. |
| `quietHours.endTime` | string `HH:mm` | `"08:00"` | 24-hour clock, exclusive. |
| `quietHours.timezone` | string | `"UTC"` | IANA zone name, e.g. `America/New_York`. |
| `quietHours.daysOfWeek` | integer[] | `[0,1,2,3,4,5,6]` | `0` = Sunday … `6` = Saturday. |
| `quietHours.allowCriticalAlerts` | boolean | `true` | Critical events bypass quiet hours when `true`. |
| `updatedAt` | string (ISO 8601) | time of the request | Read-only. Set by the server on every successful `PUT`. |

Defaults come from `DEFAULT_PREFS` in the route and `DEFAULT_QUIET_HOURS` in
`app/lib/quiet-hours.ts`. A user who has never saved preferences receives the
defaults.

> **Storage note:** preferences are kept in an in-memory `Map` inside the server
> process. They are not shared between server instances and are lost on restart.

---

## `GET /api/notifications/preferences`

Returns the caller's preferences.

### Request

```http
GET /api/notifications/preferences HTTP/1.1
Authorization: Bearer <token>
```

### Response `200 OK`

```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "4ec6de4ee16a76ad1149976e2c898c9460e0f2742ced9129c73fb2e5fbaf24c5"
Cache-Control: private, max-age=0, must-revalidate
```

```json
{
  "preferences": {
    "userId": "user_42",
    "email": true,
    "inApp": true,
    "webhook": false,
    "soundEnabled": true,
    "events": {
      "streamCreated": true,
      "streamCompleted": true,
      "paymentFailed": true,
      "streamCancelled": true,
      "lowBalance": false
    },
    "quietHours": {
      "enabled": false,
      "startTime": "22:00",
      "endTime": "08:00",
      "timezone": "UTC",
      "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
      "allowCriticalAlerts": true
    },
    "updatedAt": "2026-11-23T08:15:00.000Z"
  }
}
```

### Errors

| Status | `error.code` | When |
| ------ | ------------ | ---- |
| `401` | `UNAUTHORIZED` | Missing or invalid `Authorization` header. |
| `429` | `rate_limit_exceeded` | `read` bucket exhausted. |

### Conditional `GET` (`If-None-Match`)

The `GET` handler currently **does not evaluate `If-None-Match`** and never
returns `304 Not Modified`. Every authenticated request that passes the rate
limit gets a full `200` response with a fresh `ETag`. Sending `If-None-Match` is
harmless but has no effect. Clients should use the returned `ETag` only for
`If-Match` on `PUT`. (`/api/streams` and `/api/exports` do implement `304`;
this route does not.)

---

## `PUT /api/notifications/preferences`

Applies a **partial update** and returns the full updated object.

### Request

```http
PUT /api/notifications/preferences HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
If-Match: "4ec6de4ee16a76ad1149976e2c898c9460e0f2742ced9129c73fb2e5fbaf24c5"

{ "soundEnabled": false, "events": { "lowBalance": true } }
```

`If-Match` is optional (see [ETag lifecycle](#etag-lifecycle)).

### Body rules

The body must be a JSON object. Every key is optional; send only what changes.

| Key | Type | Rules |
| --- | ---- | ----- |
| `email`, `inApp`, `webhook`, `soundEnabled` | boolean | Must be real booleans (`"true"` or `1` is rejected). |
| `events` | object | Only `streamCreated`, `streamCompleted`, `streamCancelled`, `paymentFailed`, `lowBalance`; each a boolean. |
| `quietHours` | object | Only `enabled`, `startTime`, `endTime`, `timezone`, `daysOfWeek`, `allowCriticalAlerts`; validated as below. |

Any other key at the top level (including `userId` and `updatedAt`), inside
`events`, or inside `quietHours` causes the whole request to be rejected. An
empty object `{}` is valid: nothing changes except `updatedAt`, so the `ETag`
changes.

`quietHours` validation (`validatePartialQuietHours`):

| Field | Rule |
| ----- | ---- |
| `enabled`, `allowCriticalAlerts` | Boolean. |
| `startTime`, `endTime` | String matching `HH:mm`, `00:00`–`23:59`. Surrounding whitespace is trimmed. |
| `timezone` | Non-empty string, at most 100 characters, accepted by `Intl.DateTimeFormat` as an IANA zone. Trimmed. |
| `daysOfWeek` | Array of integers `0`–`6` with no duplicates. Stored sorted ascending. |

`startTime` and `endTime` may be equal or `startTime` may be later than
`endTime`; these are interpreted by the quiet-hours engine (equal times mean a
full 24-hour window, a later start means the window crosses midnight), not
rejected by validation.

### Merge semantics

The update is applied on top of the stored (or default) preferences:

| Part | Behaviour |
| ---- | --------- |
| Top-level booleans (`email`, `inApp`, `webhook`, `soundEnabled`) | Replaced if present, untouched if absent. |
| `events` | **Shallow-merged per key.** Sending `{ "events": { "lowBalance": true } }` changes only `lowBalance`. |
| `quietHours` | **Shallow-merged per key.** Sending `{ "quietHours": { "enabled": true } }` keeps the existing times and timezone. |
| `quietHours.daysOfWeek` | **Replaced as a whole array**, not merged element by element. |
| `updatedAt` | Always set to the server time of the update. |

### Response `200 OK`

```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "<new strong ETag>"
Cache-Control: private, max-age=0, must-revalidate
```

The body has the same shape as `GET`: `{ "preferences": { ... } }`. The `ETag`
in the response identifies the **new** state; use it for the next `If-Match`.

### Check order and errors

`PUT` performs its checks in this order, and the first failure wins:

1. Rate limit → `429`
2. Authentication → `401`
3. Body size and JSON parsing → `413` / `400`
4. Body validation → `400`
5. `If-Match` comparison → `409`

So a request with both an invalid body and a stale `If-Match` returns `400`,
not `409`.

| Status | `error.code` | When |
| ------ | ------------ | ---- |
| `400` | `EMPTY_BODY` | Request body has zero bytes. |
| `400` | `INVALID_JSON` | Body is not valid UTF-8 JSON. |
| `400` | `INVALID_BODY` | Body is not an object, has an unknown key, a wrong type, or fails `quietHours` validation. The message is generic and does not name the offending field. |
| `401` | `UNAUTHORIZED` | Missing or invalid `Authorization` header. |
| `403` | `CSRF_TOKEN_INVALID` | Cookie-bearing request without a valid `x-csrf-token` (from middleware). |
| `409` | `STATE_CONFLICT` | `If-Match` does not match the current `ETag`. |
| `413` | `REQUEST_TOO_LARGE` | Body exceeds the API size limit (default 256 KiB). See [BODY-SIZE-LIMITS.md](../BODY-SIZE-LIMITS.md). |
| `429` | `rate_limit_exceeded` | `write` bucket exhausted. Includes `Retry-After`. |

### Error envelope

Errors use the shared envelope. `request_id` is taken from the `x-request-id`
(or `request-id`) request header when present, otherwise generated.

```json
{
  "error": {
    "code": "STATE_CONFLICT",
    "message": "Notification preferences have been modified concurrently. Please reload and retry.",
    "request_id": "7c2f0f0e-9c52-4a3f-9d0d-5b7f5c0d9f10"
  }
}
```

---

## ETag lifecycle

### How the ETag is computed

`computeETag(actorId, preferences)` returns a **strong** ETag: the SHA-256 of
`tenant=<actorId>\n<canonical JSON of the whole preferences object>`, as 64
lowercase hex characters inside double quotes. Keys are sorted before hashing,
so property order never matters. Because `updatedAt` and `userId` are part of
the hashed object, any successful `PUT` (even one that changes nothing) produces
a new ETag, and two users never share an ETag.

### Reading it

Every `200` from `GET` and `PUT` carries an `ETag` header. Store the value
exactly as received, including the quotes.

### Sending `If-Match` on `PUT`

| `If-Match` header | Result |
| ----------------- | ------ |
| Absent or empty | Update is applied unconditionally (last write wins). |
| Matches the current ETag | Update is applied. |
| Does not match | `409 STATE_CONFLICT`; nothing is written. |
| `*` | Always matches, so it behaves like no header. |
| Comma-separated list | Matches if **any** entry equals the current ETag. |

Comparison is done by `ifNoneMatchMatches` from `app/lib/etag.ts` (the same
helper used for `If-None-Match` elsewhere): a leading `W/` weak prefix is
ignored and malformed entries simply never match.

### Never-saved users

Until a user has saved preferences once, the defaults are generated on each
request with a **fresh `updatedAt`**, and `updatedAt` is part of the hash. The
`ETag` of a never-saved user therefore differs on every `GET`, so a `PUT` that
sends an `If-Match` taken from an earlier `GET` will normally get `409`.
For the first save, **omit `If-Match`**. After that first successful `PUT` the
stored state is stable and `If-Match` works as described.

### Recovering from a `409`

1. `GET /api/notifications/preferences` to reload the current state and its new
   `ETag`.
2. Re-apply your change on top of the reloaded values. Because `PUT` is a
   partial update, you usually only need to resend the fields you meant to
   change.
3. Retry the `PUT` with `If-Match` set to the new `ETag`.

---

## Worked example: `If-Match` conflict

Two browser tabs, A and B, hold the same preferences. The `ETag` values below
were computed with `computeETag` for user `user_42` and are real, not
placeholders.

**1. Both tabs load the preferences.** Both receive:

```http
ETag: "4ec6de4ee16a76ad1149976e2c898c9460e0f2742ced9129c73fb2e5fbaf24c5"
```

with `soundEnabled: true`, `webhook: false`, `updatedAt: 2026-11-23T08:15:00.000Z`.

**2. Tab A turns sound off and wins the race.**

```http
PUT /api/notifications/preferences
If-Match: "4ec6de4ee16a76ad1149976e2c898c9460e0f2742ced9129c73fb2e5fbaf24c5"

{ "soundEnabled": false }
```

```http
HTTP/1.1 200 OK
ETag: "4321787a0fc3a7be7d6852f97198107d35de5fdfaba8df09c6fbb1d59daa07d9"
```

**3. Tab B, still holding the old ETag, enables the webhook.**

```http
PUT /api/notifications/preferences
If-Match: "4ec6de4ee16a76ad1149976e2c898c9460e0f2742ced9129c73fb2e5fbaf24c5"

{ "webhook": true }
```

```http
HTTP/1.1 409 Conflict
```

```json
{
  "error": {
    "code": "STATE_CONFLICT",
    "message": "Notification preferences have been modified concurrently. Please reload and retry.",
    "request_id": "7c2f0f0e-9c52-4a3f-9d0d-5b7f5c0d9f10"
  }
}
```

Nothing was written, so Tab A's change is preserved.

**4. Tab B reloads.**

```http
GET /api/notifications/preferences
```

```http
HTTP/1.1 200 OK
ETag: "4321787a0fc3a7be7d6852f97198107d35de5fdfaba8df09c6fbb1d59daa07d9"
```

The body now shows `soundEnabled: false`, from Tab A.

**5. Tab B re-applies its change with the fresh ETag.**

```http
PUT /api/notifications/preferences
If-Match: "4321787a0fc3a7be7d6852f97198107d35de5fdfaba8df09c6fbb1d59daa07d9"

{ "webhook": true }
```

```http
HTTP/1.1 200 OK
ETag: "71ee91673147f874f87a42265ecd0ae09de2b1281540afce3b8ffca11025a485"
```

The result contains **both** changes: `soundEnabled: false` from Tab A and
`webhook: true` from Tab B.

---

## Related

- Body size caps: [BODY-SIZE-LIMITS.md](../BODY-SIZE-LIMITS.md)
- Rate limits: [rate-limits.md](../rate-limits.md)
- Error codes: [error-codes.md](../error-codes.md)
- Auth flow: [auth-wallet.md](auth-wallet.md)
- Existing route tests: `app/api/notifications/preferences/route.test.ts`
  (currently in the Jest quarantine list in `jest.config.js`) and
  `route.bodySize.test.ts`
