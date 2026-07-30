# /api/streams Input Validation

Both `/api/streams` handlers validate input at the boundary with Zod schemas
in `app/lib/stream-validation.ts`.

## POST /api/streams

`createStreamSchema` is now a first-class Zod schema and
`validateCreateStreamBody` delegates to it. For object bodies the error
contract is unchanged: the same per-field errors as before
(`MISSING_FIELD`, `INVALID_STELLAR_KEY`, `INVALID_RATE_FORMAT`,
`NEGATIVE_RATE`, `DECIMAL_PRECISION_EXCEEDED`, `INVALID_SCHEDULE`,
`INVALID_TOKEN_FORMAT`), returned in the existing 422 `VALIDATION_ERROR`
envelope with `details`.

Non-object JSON bodies changed: an array, string, or number body previously
produced three `MISSING_FIELD` details, and a JSON `null` body crashed the
handler (an unhandled 500). All of them now return a single
`{ field: "body", code: "INVALID_TYPE" }` detail.

## GET /api/streams

Query params are now validated (`listStreamsQuerySchema`) instead of silently
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
