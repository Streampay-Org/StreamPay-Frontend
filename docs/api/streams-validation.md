# /api/streams Input Validation

Both `/api/streams` handlers validate input at the boundary with Zod schemas
in `app/lib/stream-validation.ts`.

## POST /api/streams

`createStreamSchema` is a first-class Zod schema and
`validateCreateStreamBody` and `parseCreateStreamBody` delegate to it.

### Normalisation Rules

When a stream is created (via `POST /api/streams`, `/api/streams/batch`, or `/api/streams/import`), values are persisted in their validated, normalised forms:

- **Recipient**: Trimmed Stellar public key (removes leading and trailing whitespace).
- **Rate**: Canonical decimal form (trimmed, no leading zeros except `0.` for fractional numbers, no trailing fractional zeros, and no trailing decimal point). For example, `"0050.5000"` is stored as `"50.5"`.
- **Schedule**: Trimmed and lowercased string matching a supported schedule (`"second"`, `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"`, `"year"`). For example, `"Month"` is stored as `"month"`.

### Rate Upper Bound & Range Checks

- **Maximum Rate**: The rate cannot exceed Stellar's int64 stroop capacity (`STELLAR_MAX_I64 = 9,223,372,036,854,775,807` stroops, or `922337203685.4775807`). Rates exceeding this bound yield `422 RATE_TOO_LARGE`. BigInt stroop math is used to avoid IEEE-754 precision loss.
- **Zero Rate**: Rate equal to `"0"` yields `422 RATE_NOT_POSITIVE`. The error details retain `alias: "NEGATIVE_RATE"` for backwards compatibility.
- **Negative / Malformed Rate**: Negative numbers or non-decimal formats yield `422 INVALID_RATE_FORMAT` or `422 NEGATIVE_RATE`.
- **Decimal Precision**: At most 7 decimal places are supported; exceeding 7 decimals yields `422 DECIMAL_PRECISION_EXCEEDED`.

### Idempotency Fingerprint

The idempotency fingerprint is calculated over the raw incoming request body before normalisation. This ensures that a client changing whitespace or casing across duplicate submissions is flagged for idempotency conflicts.

### Non-object JSON Bodies

An array, string, number, or JSON `null` body returns a single `{ field: "body", code: "INVALID_TYPE" }` detail.

## GET /api/streams

Query params are validated (`listStreamsQuerySchema`) instead of silently
degrading:

| Query param | Rules | Error code |
| ----------- | ----- | ---------- |
| `limit`     | Optional. Integer 1-100 (default 20). | `INVALID_LIMIT` |
| `status`    | Optional. One of `draft`, `active`, `paused`, `ended`, `withdrawn`, `cancelled`. | `INVALID_STATUS` |
| `cursor`    | Optional. Non-empty string; decoding is still checked separately (`INVALID_CURSOR` at the top level). | `INVALID_CURSOR` |

Unknown query params are ignored.

Behavior changes, all previously silent degradations:

- A malformed `limit` produced an empty list (`parseInt` NaN propagated into
  the slice); it is now a 422.
- `limit` greater than 100 was silently clamped to 100; it is now a 422.
- An unknown `status` matched nothing and returned an empty list; it is now
  a 422.

All failures use the same 422 `VALIDATION_ERROR` envelope with per-field
`details` as the POST body path.

## Tenant & Ownership Scoping (`GET /api/streams` and `GET /api/v2/streams`)

Both list endpoints filter streams with `visibleTo(actor, tenant)(stream)` (`app/lib/stream-visibility.ts`) **before** status filtering, cursor slicing, and ETag computation:

1. **Tenant isolation**: A stream is only visible when its resolved tenant (`stream.tenantId ?? stream.tenant ?? "default-tenant"`) matches the caller's resolved tenant (`x-tenant-id` / `x-streampay-tenant-id` header or `sp_tenant_id` cookie, defaulting to `"default-tenant"`).
2. **Ownership & role rules**:
   - **Authenticated callers**: The caller must be the stream's `senderAddress`, the `recipient`, a member of the owning organisation (`stream.orgId` or `orgDb.streamOwnership`), or an `admin`.
   - **Unauthenticated v1 callers (`GET /api/streams`)**: Restricted to the resolved tenant only, and PII fields (`email`, `label`, `memo`, `partnerId`) are omitted (`redactStreamPii`) from every stream in the response.
   - **v2 fallback (`GET /api/v2/streams`)**: Uses the verified actor from the request when available and falls back to the tenant-only rule when only an unverified opaque bearer token is present.
3. **Filtered `meta.total` & ETags**: `meta.total` reports the filtered stream count visible to the caller (never the global store size), and strong ETags are computed over the caller's filtered (and, when unauthenticated on v1, PII-redacted) response payload.
4. **Cursor safety**: A pagination cursor (composite keyset or legacy plain-ID) pointing to a stream that the caller cannot see is rejected with `422 INVALID_CURSOR`, identical to an unknown cursor, preventing cross-tenant existence leaks.
5. **Secondary index (`InMemoryStreamRepository`)**: `IndexedStreamStore` in `app/lib/repositories/in-memory.ts` maintains in-memory secondary indexes by tenant (`byTenant`) and participant wallet (`byParticipant`) across `set`, `delete`, `clear`, and `reset` operations so listing is scoped to the tenant index rather than scanning all streams across all tenants.

> **Follow-up note**: `GET /api/streams/search` (`app/api/streams/search/route.ts`) is tracked separately as a follow-up for tenant and ownership scoping.

