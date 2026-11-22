# Rate Limiting

StreamPay API implements rate limiting to protect against abuse, scraping, and DoS attacks.

## Default Limits

| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| Read (GET) | 60 requests | 1 minute |
| Write (POST/DELETE) | 10 requests | 1 minute |
| Reconciliation (`GET /api/reconciliation`) | 30 requests | 1 minute |
| Webhooks (`GET|POST /api/webhooks`) | 30 requests | 1 minute |

## Identification Priority

When determining rate limits, the API identifies clients in the following priority order:

1. **API Key** (`X-API-Key` header) - Highest priority
2. **Wallet** (JWT Bearer token `sub` claim) - For authenticated requests
3. **IP Address** (`X-Forwarded-For` or `X-Real-IP` header) - Fallback

### NAT Caveats

If your infrastructure uses shared NAT, multiple legitimate users may appear to share the same IP address. This could cause rate limits to trigger unexpectedly. Consider:

- Using API keys for server-to-server calls
- Using wallet authentication for user-level tracking
- Contacting support if you need higher limits for NAT-heavy environments

## 429 Response

When a rate limit is exceeded, the API returns a `429 Too Many Requests` response:

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Rate limit exceeded. Please try again later."
  }
}
```

The response includes a `Retry-After` header indicating when you can retry:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

## Rate Limited Endpoints

All API endpoints are rate limited:

| Method | Endpoint | Limit Type |
|--------|----------|------------|
| GET | `/api/streams` | Read |
| GET | `/api/streams/{id}` | Read |
| POST | `/api/streams` | Write |
| DELETE | `/api/streams/{id}` | Write |
| POST | `/api/streams/{id}/start` | Write |
| POST | `/api/streams/{id}/pause` | Write |
| POST | `/api/streams/{id}/stop` | Write |
| POST | `/api/streams/{id}/settle` | Write |
| POST | `/api/streams/{id}/withdraw` | Write |
| POST | `/api/streams/{id}/webhooks/test` | Write |
| GET | `/api/activity` | Read |
| GET | `/api/identity/me` | Read |
| GET | `/api/auth/wallet` | Challenge (20 req/min per IP) |
| POST | `/api/auth/wallet` | Login (5 req/min per IP) |
| POST | `/api/exports` | Export (5 req/min per user) |
| GET | `/api/reconciliation` | Reconciliation (30 req/min per user) |
| GET | `/api/webhooks` | Webhook (30 req/min per user) |
| POST | `/api/webhooks` | Webhook (30 req/min per user) |

## Wallet Authentication Limits

The `/api/auth/wallet` endpoint uses IP-based rate limiting with stricter thresholds for login attempts:

| Operation | Limit | Window | Purpose |
|-----------|-------|--------|---------|
| GET (challenge) | 20 requests | 1 minute | Prevent abuse of challenge generation |
| POST (login) | 5 requests | 1 minute | Prevent brute-force login attempts |

These limits apply per IP address and are independent of the general rate limiting system. Each IP is tracked separately, and limits are enforced using the same token bucket algorithm.

### 429 Response for Wallet

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests. Please try again later.",
    "request_id": "req_01HZ9ABCDEF"
  }
}
```

Headers:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
x-request-id: req_01HZ9ABCDEF
```

Throttle events are also emitted as structured JSON logs
(`event: "wallet_ip_rate_limit_exceeded"`) including the same `request_id`
for correlation across gateways and SIEM.

## Requesting Higher Limits

If your use case requires higher rate limits:

1. **For production deployments**: Contact StreamPay support with your:
   - Expected request volume
   - Use case description
   - Whether you need per-key or per-wallet limits

2. **For testing/development**: The in-memory rate limit store is suitable for single-instance deployments.

## Metrics and Monitoring

Rate limiting emits structured logs for monitoring:

```json
{
  "event": "rate_limit_throttled",
  "route": "/api/streams",
  "limitType": "read",
  "timestamp": "2026-04-28T12:00:00.000Z",
  "identityType": "wallet",
  "identityDisplay": "GATODH2T75IVFB..."
}
```

Monitor these events to tune rate limits and detect potential abuse.

## Shared Redis Rate-Limit Store

On Vercel and other serverless platforms, multiple instances serve traffic
concurrently.  Using the in-memory store on those platforms means each instance
maintains its own independent bucket, so a client that hits N instances can
make up to `limit × N` requests before being throttled.

The Redis-backed store fixes this by keeping a single, globally-shared token
bucket per identifier, advanced atomically with a Lua `EVAL` script so no two
instances can double-spend a token.

### Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `RATE_LIMIT_REDIS_URL` | When using Redis | Upstash REST endpoint, e.g. `https://your-db.upstash.io` |
| `RATE_LIMIT_REDIS_TOKEN` | When `RATE_LIMIT_REDIS_URL` is set | Upstash REST API bearer token |
| `RATE_LIMIT_FAIL_MODE` | No (default `open`) | `open` or `closed` (see below) |

When both `RATE_LIMIT_REDIS_URL` and `RATE_LIMIT_REDIS_TOKEN` are set,
`getRateLimitStore()` automatically returns a `RedisRateLimitStore`.
Otherwise it falls back to `InMemoryRateLimitStore`.

### Key format

```
streampay:rl:v1:{limitType}:{identifierValue}
```

Keys are stored as Redis hashes (`HMGET`/`HMSET`) and given a TTL of
`2 × windowMs` seconds so stale buckets expire automatically.

### Failure policy

Each call to the store has a hard timeout of **150 ms**.  If Redis is
unreachable or returns an error, the configured fail mode takes over:

| Mode | Behaviour | Recommended for |
|------|-----------|-----------------|
| `open` | Allow the request; return remaining=limit−1 | Read tiers, export |
| `closed` | Consult a local shadow bucket (cap=10 tokens per identifier); deny if shadow is also empty | Login (`POST /api/auth/wallet`), write tiers |

The local shadow bucket ensures that a full Redis outage in `closed` mode does
not hard-lock every caller.  Because the shadow bucket is per-process and
capped, an attacker cannot exploit an outage to exceed the shadow cap ×
instances, which is substantially lower than `limit × instances`.

### Metrics

Every Redis error increments the Prometheus counter
`rate_limit_store_unavailable_total` (no labels).  Scrape it from
`GET /api/metrics` and alert when the rate is non-zero.

```promql
# Alert if more than 1% of requests in 5-min window hit an unavailable store
rate(rate_limit_store_unavailable_total[5m]) > 0.01
```

### Choosing a fail mode per tier

| Tier | Default fail mode | Rationale |
|------|-------------------|-----------|
| `read` | `open` | Throughput matters more than strict enforcement for read traffic |
| `write` | `open` | A single Vercel instance can still enforce the limit locally |
| `login` | **`closed`** | Brute-force protection must hold even under Redis outage |
| `export` | `open` | Exports are slow by design; throughput should not be blocked |

To override globally, set `RATE_LIMIT_FAIL_MODE=closed`.  The same variable
applies to all tiers; per-tier override is a future enhancement.

### Upstash setup

1. Create a database at [console.upstash.com](https://console.upstash.com).
2. Copy the **REST URL** and **REST Token** from the database page.
3. Add them to your Vercel environment:
   ```
   RATE_LIMIT_REDIS_URL=https://your-db.upstash.io
   RATE_LIMIT_REDIS_TOKEN=AXxxxxxx...
   RATE_LIMIT_FAIL_MODE=open
   ```
4. Redeploy.  `GET /api/metrics` should show
   `rate_limit_store_unavailable_total 0` in healthy state.

### Load test (verifying global limit)

Run two local instances sharing the same Redis to confirm the global limit
holds:

```bash
# Terminal 1
PORT=3000 npm start

# Terminal 2
PORT=3001 npm start

# Terminal 3 — drive 120 concurrent requests split across both instances
npx autocannon -c 60 -d 5 http://localhost:3000/api/streams \
  & npx autocannon -c 60 -d 5 http://localhost:3001/api/streams
```

With `RATE_LIMIT_STORE_TYPE=in-memory`, both instances independently honour
the 60 req/min read limit, so up to ~120 requests succeed before a 429.
With the Redis store, the combined total across both instances should not
exceed 60 (the global limit) in any 60-second window.

## Implementation Details

### Token Bucket Algorithm

Rate limits use a token bucket algorithm, which allows for:

- **Burst handling**: Requests can use up to the limit in short bursts
- **Smooth refill**: Tokens refill at a constant rate
- **Fairness**: Each identifier gets an equal share of the limit

### Store Backends

| Backend | Use Case | Configuration |
|---------|----------|---------------|
| In-Memory | Development, single-instance | Default (no config needed) |
| Redis | Production, multi-instance | Set `RATE_LIMIT_STORE_TYPE=redis` and `RATE_LIMIT_REDIS_URL` |

### Security Considerations

- Rate limit thresholds are not exposed in error responses (no information leakage)
- Internal metrics track throttle counts by route for alerting
- In-memory whitelist is for single-instance use only

## Best Practices

1. **Handle 429 responses gracefully** - Implement exponential backoff
2. **Use idempotency keys** - For POST requests to safely retry on network failure
3. **Monitor your usage** - Track response headers to stay within limits
4. **Batch requests when possible** - Use list endpoints instead of individual GETs
