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