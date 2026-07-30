# `/api/streams` per-endpoint Prometheus metrics

## Overview
`GET` and `POST` `/api/streams` now emit Prometheus **counter** and
**histogram** series so operators can track request volume and latency per
HTTP method and status code.

## Metrics
Registered in `src/metrics/registry.ts` (same registry as webhooks):

| Name | Type | Labels | Description |
| --- | --- | --- | --- |
| `streams_requests_total` | Counter | `method`, `status` | Total `/api/streams` requests |
| `streams_request_duration_seconds` | Histogram | `method`, `status` | End-to-end handler duration |

Scrape via the existing Prometheus text exposition on `GET /api/webhooks`
(shared `registry`).

## Implementation
- `app/api/streams/route.ts` wraps `GET`/`POST` in `try`/`finally` and calls
  `observeStreamsRequest(method, status, start)` so every exit path
  (success, validation, rate-limit, errors) is counted.
- Correlation / structured logging is unchanged.

## Testing
`__tests__/streams-metrics.test.ts` covers metric registration and
GET/POST success + error status labels.
