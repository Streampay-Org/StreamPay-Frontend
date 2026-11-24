# Reconciliation Overview API

`GET /api/reconciliation` returns a public reconciliation overview for the
GrantFox FWC26 campaign. Results are ordered by `(created_at, id)` for stable
cursor pagination.

## Query parameters

| Param | Rules |
| ----- | ----- |
| `limit` | Optional. Integer 1–1000 (default `100`). Invalid values return `400 INVALID_INPUT`. |
| `cursor` | Optional. Opaque composite cursor encoding `(created_at,id)`. Empty or malformed values return `422 INVALID_CURSOR`. |

## Response shape

```json
{
  "status": "success",
  "data": [
    {
      "id": "rec-pub-3",
      "created_at": "2026-07-24T12:00:00.000Z",
      "totalReconciled": 900,
      "currency": "EURC",
      "status": "completed"
    }
  ],
  "meta": {
    "total": 3,
    "limit": 100,
    "hasNext": false,
    "nextCursor": null
  }
}
```

Pass `meta.nextCursor` as the next request's `cursor` query param to continue
walking the list. Ordering is `created_at DESC`, then `id DESC`.

Strong `ETag` / `If-None-Match` caching continues to apply to the full JSON
payload (including pagination meta).

Rate limits: see [rate-limits.md](../rate-limits.md).
