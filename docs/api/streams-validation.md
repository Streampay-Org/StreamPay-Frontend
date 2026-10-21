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
