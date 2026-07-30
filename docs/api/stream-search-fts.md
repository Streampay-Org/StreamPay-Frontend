# Stream Search API (Full-Text Search)

The Stream Search API endpoint `GET /api/streams/search` provides full-text search (FTS) and filtering capabilities across stream records in StreamPay.

## Endpoint

`GET /api/streams/search`

## Authentication & Rate Limits

- **Auth**: Standard bearer token authentication or API key.
- **Rate Limit**: Read bucket limits apply (60 requests / minute per client identity). Excess requests return HTTP `429 Too Many Requests`.

## Query Parameters

| Parameter | Type | Default | Constraints / Validation | Description |
|-----------|------|---------|-------------------------|-------------|
| `q` | string | `""` | Optional | Full-text query string. Tokenized by space (AND matching) across `id`, `recipient`, `memo`, `label`, `email`, `senderAddress`, `partnerId`, and `token`. |
| `status` | string | `undefined` | Must be one of: `draft`, `active`, `paused`, `ended`, `withdrawn`, `cancelled` | Filters streams by lifecycle status. Returns `400 Bad Request` if invalid status supplied. |
| `asset` / `token` | string | `undefined` | Optional | Filter streams by asset symbol or SEP-41 token address (e.g. `XLM`, `USDC`). |
| `sender` / `senderAddress` | string | `undefined` | Optional | Filter streams by sender address. |
| `recipient` | string | `undefined` | Optional | Filter streams by recipient name or address (case-insensitive substring match). |
| `from` | string (ISO-8601) | `undefined` | Valid ISO-8601 date string | Filter streams created on or after this timestamp (`createdAt >= from`). |
| `to` | string (ISO-8601) | `undefined` | Valid ISO-8601 date string | Filter streams created on or before this timestamp (`createdAt <= to`). |
| `limit` | integer | `50` | `1 <= limit <= 200` | Maximum number of records to return. |
| `offset` | integer | `0` | `offset >= 0` | Number of matching records to skip for pagination. |

## Response Envelopes

### Success (HTTP 200 OK)

```json
{
  "data": [
    {
      "id": "stream-ada",
      "recipient": "Ada Creative Studio",
      "rate": "120 XLM / month",
      "schedule": "Pays every 30 days",
      "status": "active",
      "createdAt": "2026-04-01T09:00:00Z",
      "updatedAt": "2026-04-28T10:30:00Z",
      "token": "XLM",
      "senderAddress": "GD7H...3J4K",
      "label": "Design Retainer Q2"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 50,
    "offset": 0,
    "count": 1,
    "query": "ada"
  },
  "links": {
    "self": "/api/streams/search?q=ada"
  }
}
```

### Validation Error (HTTP 400 Bad Request)

Returned when a query parameter fails boundary validation (e.g., malformed date string, invalid status, or invalid limit/offset boundary):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid 'from' date format. Must be a valid ISO-8601 date string.",
    "request_id": "req-8f4b23a1"
  }
}
```

### Rate Limit Exceeded (HTTP 429 Too Many Requests)

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Rate limit exceeded. Please try again later."
  }
}
```

## Observability & Correlation Tracking

Every search request extracts or generates `request_id` and `correlation_id` headers (`x-request-id`, `x-correlation-id`). Structured logs are produced with search metrics and correlation context for end-to-end tracing.
