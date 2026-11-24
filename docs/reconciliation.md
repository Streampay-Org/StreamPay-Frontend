# Nightly Reconciliation

DB vs Stellar indexer diff, runs once per day via cron.

## Endpoint
`POST /api/internal/reconciliation/nightly`  internal, cron-only.

### Authentication
`X-Cron-Secret: <RECON_CRON_SECRET>` *or* `Authorization: Bearer <RECON_CRON_SECRET>`.
Compared with `crypto.timingSafeEqual`. **Fails closed when `RECON_CRON_SECRET` is unset.**

### Request body (all fields optional, unknown keys rejected)
| Field      | Type    | Default                | Notes                                  |
|------------|---------|------------------------|-----------------------------------------|
| `sinceISO` | string  | now - 24h              | ISO-8601 datetime; lower bound for diff |
| `dryRun`   | boolean | `false`                | If true, returns diff without logging divergence |
| `pageSize` | integer | `1000` (clamped 100-5000) | Per-page fetch size                 |

### Response 200
```json
{
  "ok": true,
  "correlationId": "uuid",
  "startedAt": "ISO", "finishedAt": "ISO",
  "sinceISO": "ISO", "dryRun": false,
  "summary": {
    "totalDBRows": 0, "totalIndexerRows": 0,
    "missingInIndexerCount": 0, "missingInDBCount": 0,
    "mismatchedAmountCount": 0, "mismatchedStatusCount": 0
  },
  "diff": {
    "missingInIndexer": [],  "missingInDB": [],
    "mismatchedAmount": [], "mismatchedStatus": []
  },
  "nextCursor": null
}
```

### Kind-Aware Reconciliation (`standard`, `split`, `recurring`)

Rows from the database and indexer carry an optional `kind` (`"standard" | "split" | "recurring"`, defaulting to `"standard"`). Comparisons are keyed by `(kind, id)` so identical IDs across different stream kinds never collide.

- **Standard-only runs**: When all rows are `"standard"` (or omit `kind`), the response shape is unchanged — `summary` contains only the top-level counts and `diff` entries omit `kind`.
- **Mixed-kind runs**: Whenever any `"split"`, `"recurring"`, or unknown indexer kind is present:
  - `summary.byKind` is populated with per-kind counts (`totalDBRows`, `totalIndexerRows`, `missingInIndexerCount`, `missingInDBCount`, `mismatchedAmountCount`, `mismatchedStatusCount`). Top-level counts remain the aggregate totals across all kinds.
  - Every entry in `diff.missingInIndexer`, `diff.missingInDB`, `diff.mismatchedAmount`, and `diff.mismatchedStatus` includes `kind`.
- **Amount normalisation (bigint math)**:
  - `standard`: compared as canonical base-10 bigint string from `amount`.
  - `split`: prefers `total` or `total_amount` over `amount`.
  - `recurring`: computes `amount_per_cycle * total_cycles` using `BigInt` when both fields are present, falling back to `total_amount` / `amount`.
- **Unknown kinds**: Any unexpected `kind` emitted by the indexer is preserved under its own key in `summary.byKind` and `diff` rather than being merged into `"standard"`.

### Cron
```cron
0 2 * * *  curl -fsS -X POST \
  -H "X-Cron-Secret: $RECON_CRON_SECRET" \
  -H "X-Request-Id: recon-$(date -u +%Y%m%dT%H%M%SZ)" \
  https://<host>/api/internal/reconciliation/nightly
```

### Errors
Standard envelope: `{ "error": { "code", "message", "correlationId", "details?" } }`.
Codes: `UNAUTHORIZED` (401), `VALIDATION_FAILED` (400), `INTERNAL` (500).
Every response (success or error) carries `x-correlation-id`.