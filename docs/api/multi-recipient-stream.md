# Multi-Recipient Stream Creation API

Creates a multi-recipient (fan-out) stream: one stream is written per
recipient, each locked to its own share of a single total and sharing the same
start/end window.

> **Status: Live.**
> The route implemented in `app/api/v2/streams/multi/route.ts` is live on `main`.
> This document describes that route — it is not a proposal.
>
> **There is no `/api/v1/streams/multi` route and there never was one.**
> The v1 API is deprecated and returns `410 Gone` after 2026-12-31
> (see [`api-v2-migration.md`](../api-v2-migration.md)); the path that appears
> in older copies of this page is not a valid integration target.

## Endpoint

```
POST /api/v2/streams/multi
```

| Property | Value |
|----------|-------|
| Content type | `application/json` |
| Auth | `Authorization: Bearer <jwt>` (required) |
| CSRF | Browser callers must echo the `csrf-token` cookie in the `x-csrf-token` header |
| Idempotency | Send `Idempotency-Key`; replays return the original `201` body |
| Success | `201 Created` |
| Implemented by | `app/api/v2/streams/multi/route.ts` |
| Shared rules | `app/lib/multi-recipient.ts` (imported by the route *and* the wizard) |

## Request

```json
{
  "name": "GrantFox Q3 Distribution",
  "token": "XLM",
  "totalAmount": 10000,
  "startTime": "2026-09-01T09:00:00.000Z",
  "endTime": "2026-12-31T23:59:00.000Z",
  "recipients": [
    {
      "address": "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA",
      "percentage": 50,
      "amount": 5000
    },
    {
      "address": "ada@example.com",
      "percentage": 50,
      "amount": 5000
    }
  ]
}
```

This example is exactly what `buildMultiRecipientPayload()` produces for the
same inputs, and exactly what the `/streams/new/multi` wizard posts. A test
(`docs/__tests__/multi-recipient-doc.test.ts`) fails if the two ever diverge.

### Field descriptions

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `name` | string | yes | 1–120 characters after trimming |
| `token` | string | yes | One of `XLM`, `USDC` |
| `totalAmount` | number | yes | Finite and `> 0`. Sum of all legs, in token units |
| `startTime` | string | yes | ISO-8601 date-time |
| `endTime` | string | yes | ISO-8601 date-time, strictly after `startTime` |
| `recipients` | array | yes | 1–`20` entries |
| `recipients[].address` | string | yes | A Stellar ed25519 public key (Strkey, checksum validated) or a registered email address |
| `recipients[].percentage` | number | yes | `0`–`100`, at most 4 decimal places |
| `recipients[].amount` | number | no | Echo of the server-derived amount; see below |

Amounts are sent as JSON numbers here (the `totalAmount` is always well within
`Number.MAX_SAFE_INTEGER`); the **response** returns amounts and percentages as
fixed-precision decimal **strings** so no precision is lost in transit.

## Validation rules

Every rule below is enforced by `validateMultiRecipientStreamBody()` in
`app/lib/multi-recipient.ts`, which the wizard imports for its own pre-check —
the client and the server cannot disagree about what is valid.

| # | Rule | Error code | HTTP |
|---|------|-----------|------|
| 1 | `recipients` must hold **at most 20 entries** | `TOO_MANY_RECIPIENTS` | 422 |
| 2 | `recipients` must hold at least 1 entry | `EMPTY_RECIPIENTS` | 422 |
| 3 | The `percentage` values must sum to **100** | `ALLOCATION_MISMATCH` | 422 |
| 4 | Each `percentage` must be within `0`–`100` | `PERCENTAGE_OUT_OF_RANGE` | 422 |
| 5 | Each `percentage` may have at most 4 decimal places | `PERCENTAGE_PRECISION_EXCEEDED` | 422 |
| 6 | Each `address` must be a valid Stellar key or email | `INVALID_RECIPIENT_ADDRESS` | 422 |
| 7 | `endTime` must be strictly after `startTime` | `INVALID_TIME_RANGE` | 422 |
| 8 | `token` must be `XLM` or `USDC` | `UNSUPPORTED_TOKEN` | 422 |
| 9 | `totalAmount` must be `> 0` | `NON_POSITIVE_TOTAL` | 422 |
| 10 | `name` must be 1–120 characters | `MISSING_FIELD` / `NAME_TOO_LONG` | 422 |

### The 20-recipient cap

`MAX_RECIPIENTS = 20` is the hard ceiling on one fan-out. A fan-out stream
supports at most 20 recipients. It is defined once in
`app/lib/multi-recipient.ts` and enforced in two places:

* **API** — a 21st recipient is rejected with `422` and `TOO_MANY_RECIPIENTS`
  before anything is written. The first 20 legs are still validated so the
  caller sees every other problem in the same response.
* **UI** — the "+ Add Recipient" control is disabled once 20 rows exist, and a
  hint ("Maximum of 20 recipients reached.") is rendered next to it.

The cap exists because a fan-out is written as one stream per recipient: 20 is
the largest fan-out the platform will create from a single request.

### The 100% rule and rounding

Percentages are authoritative. They must sum to 100 within a tolerance of
**0.001 percentage points** — an equal split of 100% across 20 legs leaves up
to `20 × 5e-5` of accumulated 4-decimal rounding drift, so an exact `=== 100`
comparison would reject legitimate requests.

Per-recipient amounts are **recomputed by the server** as
`percentage / 100 × totalAmount` at the token's 7-decimal precision. The
remainder is absorbed by the last leg, so the legs always sum back to
`totalAmount` exactly and no dust is stranded in escrow.

`recipients[].amount` is therefore optional. When you do send it, the server
checks it against its own derived value (tolerance `1e-4`, which is what
rounding to 4 decimals costs you) and returns `AMOUNT_MISMATCH` if the two
disagree. Omit the field and the server simply derives it for you.

## Response

### `201 Created`

```json
{
  "id": "stream-multi-8f3c1a90",
  "kind": "multi_recipient",
  "name": "GrantFox Q3 Distribution",
  "token": "XLM",
  "status": "draft",
  "total_amount": "10000.0000000",
  "allocated_percentage": "100.0000",
  "recipient_count": 2,
  "start_at": "2026-09-01T09:00:00.000Z",
  "end_at": "2026-12-31T23:59:00.000Z",
  "created_at": "2026-08-14T10:22:41.118Z",
  "settlement": null,
  "recipients": [
    {
      "rank": 1,
      "stream_id": "stream-1c4b90ae",
      "address": "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA",
      "percentage": "50.0000",
      "amount": "5000.0000000"
    },
    {
      "rank": 2,
      "stream_id": "stream-77de12b0",
      "address": "ada@example.com",
      "percentage": "50.0000",
      "amount": "5000.0000000"
    }
  ],
  "links": {
    "self": "/api/v2/streams/multi",
    "collection": "/api/v2/streams"
  }
}
```

Notes on the shape:

* `id` identifies the **fan-out**. It is not itself a stream; the legs are.
* `recipients[].stream_id` is a real stream id. Fetch a leg with
  `GET /api/v2/streams/{stream_id}` and drive it through the usual
  `start` / `pause` / `stop` / `settle` lifecycle.
* The v2 field conventions apply: snake_case timestamps and an always-present
  `settlement` (`null` before settlement), matching
  [`api-v2-migration.md`](../api-v2-migration.md).

## Errors

All errors use the project's standard envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "request_id": "req_01hz…",
    "details": [
      {
        "field": "recipients",
        "code": "ALLOCATION_MISMATCH",
        "message": "Allocated percentages must sum to 100; received 90.0000."
      }
    ]
  }
}
```

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_REQUEST` | Body is not valid JSON |
| 401 | `UNAUTHORIZED` | Missing or non-`Bearer` `Authorization` header |
| 403 | `CSRF_TOKEN_INVALID` | Browser caller did not echo the `csrf-token` cookie in `x-csrf-token` (from `middleware.ts`) |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` reused with a different body |
| 422 | `VALIDATION_ERROR` | Any validation rule above; per-field detail in `error.details` |
| 429 | `ORG_DAILY_QUOTA_EXCEEDED` | Per-org daily stream quota reached; `Retry-After` header set |
| 504 | `GATEWAY_TIMEOUT` | Handler exceeded the route deadline |

`error.details[].code` is one of: `INVALID_BODY`, `MISSING_FIELD`,
`NAME_TOO_LONG`, `UNSUPPORTED_TOKEN`, `NON_POSITIVE_TOTAL`,
`INVALID_TIMESTAMP`, `INVALID_TIME_RANGE`, `INVALID_RECIPIENT`,
`INVALID_RECIPIENT_ADDRESS`, `PERCENTAGE_OUT_OF_RANGE`,
`PERCENTAGE_PRECISION_EXCEEDED`, `INVALID_AMOUNT`, `NEGATIVE_AMOUNT`,
`AMOUNT_MISMATCH`, `EMPTY_RECIPIENTS`, `TOO_MANY_RECIPIENTS`,
`ALLOCATION_MISMATCH`.

A rejected request is **atomic**: validation runs before any write, so a `422`
never leaves a partial fan-out behind.

## Quota

One fan-out consumes **one** unit of the per-org daily stream quota
(`ORG_DAILY_STREAM_QUOTA_LIMIT`, default 100), regardless of how many legs it
creates. Exceeding it returns `429` with `Retry-After` set to the seconds until
UTC midnight.

## Example

```bash
curl -X POST https://app.streampay.io/api/v2/streams/multi \
  -H "Authorization: Bearer $STREAMPAY_JWT" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: grantfox-q3-2026" \
  -d '{
    "name": "GrantFox Q3 Distribution",
    "token": "XLM",
    "totalAmount": 10000,
    "startTime": "2026-09-01T09:00:00.000Z",
    "endTime": "2026-12-31T23:59:00.000Z",
    "recipients": [
      {
        "address": "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA",
        "percentage": 50,
        "amount": 5000
      },
      { "address": "ada@example.com", "percentage": 50, "amount": 5000 }
    ]
  }'
```

Retrying the same request with the same `Idempotency-Key` returns the original
`201` body instead of creating a second fan-out.

## UI

The same flow is available in the product at `/streams/new/multi`, reachable
from the main stream-creation screen. The wizard:

* imports `buildMultiRecipientPayload()` from `app/lib/multi-recipient.ts`, so
  the payload it posts is the payload documented above;
* pre-checks the allocation and disables "Next: Review" until the split is
  complete and every address is non-empty;
* stops at 20 recipients;
* surfaces the server's `error.message` in the review step's alert region when
  a request is rejected, so the user can correct the input.

The API remains authoritative for address format; the wizard only requires a
non-empty address before it will submit.
