# Metrics API Documentation

## Overview

The `/api/metrics` endpoint provides Prometheus-formatted metrics for monitoring and observability of the StreamPay application. This endpoint is token-gated using a bearer token to prevent unauthorized access to sensitive metrics data.

## Endpoint

```
GET /api/metrics
```

## Authentication

This endpoint requires bearer token authentication. The token is configured via the `METRICS_AUTH_TOKEN` environment variable.

### Authentication Headers

The request must include the following header:

- `Authorization: Bearer <token>`

### Security Features

- **Token-based authentication**: Uses a static bearer token configured via environment variable
- **Constant-time comparison**: Token comparison uses constant-time algorithm to prevent timing attacks
- **Disabled by default**: If `METRICS_AUTH_TOKEN` is not set, the endpoint returns 503, preventing accidental exposure
- **No caching**: Response includes `Cache-Control: no-store` to prevent caching of sensitive metrics

## Response Format

### Success Response

**Status Code:** `200 OK`

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

**Headers:**
- `Cache-Control: no-store`

**Body:** Prometheus-formatted metrics text

Example response:
```
# HELP streampay_requests_total Total requests observed per route.
# TYPE streampay_requests_total counter
streampay_requests_total{route="/api/streams"} 100
streampay_requests_total{route="/api/streams/123"} 50

# HELP streampay_rate_limit_throttled_total Throttled requests per route and limit type.
# TYPE streampay_rate_limit_throttled_total counter
streampay_rate_limit_throttled_total{route="/api/streams",limit_type="org"} 5
streampay_rate_limit_throttled_total{route="/api/streams",limit_type="rate"} 3

# HELP streampay_metrics_up Whether the metrics endpoint is serving.
# TYPE streampay_metrics_up gauge
streampay_metrics_up 1
```

### Error Responses

**Endpoint Disabled (503 Service Unavailable)**
```json
{
  "error": {
    "code": "METRICS_DISABLED",
    "message": "Metrics endpoint is not configured."
  }
}
```

**Missing Authorization (401 Unauthorized)**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or malformed Authorization header."
  }
}
```

**Invalid Token (403 Forbidden)**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid metrics token."
  }
}
```

## Metrics

### Request Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `streampay_requests_total` | counter | Total requests observed per route |
| `streampay_rate_limit_throttled_total` | counter | Throttled requests per route and limit type |
| `streampay_metrics_up` | gauge | Whether the metrics endpoint is serving (always 1) |
| `webhook_requests_total` | counter | Total `/api/webhooks` requests, labelled by status and event type |
| `webhook_request_duration_seconds` | histogram | Latency of `/api/webhooks` handlers, labelled by status and event type |
| `wallet_auth_requests_total` | counter | Per-endpoint `/api/auth/wallet` request counter (see below) |
| `wallet_auth_request_duration_seconds` | histogram | Per-endpoint `/api/auth/wallet` latency histogram (see below) |
| `process_*`, `nodejs_*` | various | Default Node.js process metrics from `prom-client` |

### Labels

- `route`: The API route path (e.g., `/api/streams`, `/api/streams/123`)
- `limit_type`: The type of rate limit that was applied (e.g., `org`, `rate`)
- `status`: HTTP status code (export/webhook endpoint metrics)
- `method`: HTTP method (`GET` / `POST`) for export endpoint metrics
- `event_type`: Webhook event type label

## Per-endpoint metrics for `/api/auth/wallet`

Two new metrics back per-endpoint observability of the wallet authentication
endpoint:

| Metric | Type | Description |
|--------|------|-------------|
| `wallet_auth_requests_total` | counter | Total number of `/api/auth/wallet` requests, labelled by method, operation, and HTTP status. |
| `wallet_auth_request_duration_seconds` | histogram | Wall-clock duration of every `/api/auth/wallet` request in seconds, labelled by method, operation, and HTTP status. Bucket set: `[0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. |

### Labels

| Label | Values | Notes |
|-------|--------|-------|
| `method` | `GET`, `POST` | HTTP method that served the request. |
| `operation` | `challenge`, `verify` | `GET /api/auth/wallet` is recorded as `challenge`; `POST /api/auth/wallet` as `verify`. |
| `status` | HTTP status code as string (`"200"`, `"304"`, `"401"`, `"403"`, `"422"`, `"429"`, `"500"`, `"504"`, …) | Final HTTP status returned to the client. |

Label cardinality is intentionally bounded: `2 × 2 × ≤10` distinct time
series for typical traffic. Every handler code path — including the
pre-`withTimeout` rate-limit fast-path, conditional `304 Not Modified`
responses, validation errors, CSRF mismatches, signature-verification
failures, unhandled 500s, and 504 deadlines — produces exactly one counter
increment and one histogram observation.

### Example PromQL queries

**Challenge issuance success rate:**
```promql
sum(rate(wallet_auth_requests_total{method="GET",operation="challenge",status="200"}[5m]))
/
sum(rate(wallet_auth_requests_total{method="GET",operation="challenge"}[5m]))
```

**p99 verify latency:**
```promql
histogram_quantile(
  0.99,
  sum by (le) (
    rate(wallet_auth_request_duration_seconds_bucket{method="POST",operation="verify"}[5m])
  )
)
```

**Throttle rate by endpoint:**
```promql
sum by (method, operation) (
  rate(wallet_auth_requests_total{status="429"}[5m])
)
```

**Failed verify responses by reason (label breakdown):**
```promql
sum by (status) (
  rate(wallet_auth_requests_total{method="POST",operation="verify"}[5m])
)
```

### Notes

- These metrics are emitted from `app/api/auth/wallet/route.ts` and live on
  the shared `prom-client` registry, so they are concatenated into the body
  returned by `GET /api/metrics` alongside the `streampay_*` series.
- The histogram buckets were sized to span the wallet route's per-request
  deadline (5 s default) plus headroom for the sub-millisecond
  rate-limit-exceeded fast-path and 504 timeouts.

## Usage Examples

### Using curl

```bash
# Set your metrics token
METRICS_TOKEN="your-metrics-token-here"

# Fetch metrics
curl -X GET "http://localhost:3000/api/metrics" \
  -H "Authorization: Bearer $METRICS_TOKEN"
```

### Using Node.js

```typescript
const METRICS_TOKEN = "your-metrics-token-here";

const response = await fetch("http://localhost:3000/api/metrics", {
  method: "GET",
  headers: {
    "Authorization": `Bearer ${METRICS_TOKEN}`,
  },
});

const metrics = await response.text();
console.log(metrics);
```

### Prometheus Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'streampay'
    metrics_path: '/api/metrics'
    scheme: http
    authorization:
      credentials: 'your-metrics-token-here'
    static_configs:
      - targets: ['localhost:3000']
```

### Grafana Dashboard

Example Prometheus queries for Grafana:

**Total requests per route:**
```
rate(streampay_requests_total[5m])
```

**Throttled requests:**
```
rate(streampay_rate_limit_throttled_total[5m])
```

**Metrics endpoint health:**
```
streampay_metrics_up
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `METRICS_AUTH_TOKEN` | Yes | Bearer token for metrics endpoint authentication. If not set, the endpoint is disabled (returns 503). |

## Security Considerations

1. **Token Security**: The `METRICS_AUTH_TOKEN` should be kept secret and not committed to version control
2. **HTTPS**: Always use HTTPS in production to prevent token interception
3. **Token Rotation**: Consider rotating the metrics token periodically
4. **Access Control**: Limit which services can access the metrics endpoint
5. **Monitoring**: Monitor for unauthorized access attempts (403 responses)

## Troubleshooting

### Common Issues

**503 Service Unavailable**
- Cause: `METRICS_AUTH_TOKEN` environment variable is not set
- Solution: Set the `METRICS_AUTH_TOKEN` environment variable and restart the application

**401 Unauthorized**
- Cause: Missing or malformed `Authorization` header
- Solution: Ensure the request includes `Authorization: Bearer <token>` header

**403 Forbidden**
- Cause: Incorrect token provided
- Solution: Verify the token matches `METRICS_AUTH_TOKEN` exactly

**Empty Metrics**
- Cause: No traffic has been recorded yet
- Solution: This is normal - the `streampay_metrics_up` gauge will still be present

### Debug Mode

For debugging, you can temporarily check if the token is configured correctly:

```bash
# Check if environment variable is set
echo $METRICS_AUTH_TOKEN

# Test the endpoint
curl -v -X GET "http://localhost:3000/api/metrics" \
  -H "Authorization: Bearer $METRICS_TOKEN"
```

## Testing

The endpoint includes comprehensive tests covering:

- Authentication (missing token, malformed token, invalid token)
- Metrics generation and formatting
- Label escaping for special characters
- Empty metrics handling
- Security (constant-time comparison)

Run tests with:
```bash
npm test app/api/metrics/route.test.ts
```

Per-endpoint wallet metric tests live at `__tests__/wallet-metrics.test.ts`
and cover every observed HTTP status (200, 304, 422, 429, 403), histogram
buckets, and isolation between the `GET`/`POST` time series:

```bash
npm test __tests__/wallet-metrics.test.ts
```

## Rate Limiting

Currently, no rate limiting is implemented for the metrics endpoint. Consider adding rate limiting if the endpoint is abused or if Prometheus scraping frequency is too high.

## Future Enhancements

Potential improvements for the metrics endpoint:

1. **Additional Metrics**: Add more granular metrics (e.g., by organization, by status code)
2. **Histograms**: Add histogram metrics for request durations, response sizes, etc.
3. **Custom Labels**: Add support for custom labels (e.g., environment, region)
4. **Caching**: Implement short-term caching to reduce load (with proper cache invalidation)
5. **Rate Limiting**: Add rate limiting to prevent abuse
6. **Metrics Filtering**: Allow filtering metrics by query parameters
7. **Health Status**: Include application health status in metrics
8. **Streaming**: Support for streaming metrics updates
9. **Per-endpoint rollout**: Extend the same `Counter` + `Histogram` pattern
   to other critical routes (e.g. `/api/streams`, `/api/exports`,
   `/api/reconciliation`) so Grafana dashboards have uniform labels.
10. **Alerting rules**: Wire PromQL alerts on `wallet_auth_*` for repeated
    5xx, abnormal 429 spikes, and p99 verify latency regressions.

## Related Documentation

- [Prometheus Text Exposition Format](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [Grafana Documentation](https://grafana.com/docs/)
