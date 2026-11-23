# Observability

This page describes the structured observability signals emitted by the application.

## Access logs

Every request to an instrumented route emits exactly one structured access-log event via
`src/middleware/accessLog.ts`. The event is emitted from the handler's `finally` block so it is
produced on every exit path, including errors, short-circuits from the rate limiter, conditional
responses (304), and route timeouts (504).

### Fields

Every access event contains:

| Field           | Type     | Description                                                     |
| ---------------- | --------- | -------------------------------------------------------------------- |
| `method`         | string    | HTTP method (e.g. `GET`, `POST`).                                         |
| `path`           | string    | Route template (e.g. `/api/streams`), not the raw URL with query.            |
| `status`         | number    | HTTP response status code.                                               |
| `durationMs`     | number    | Handler duration in milliseconds, measured with `process.hrtime()`.            |
| `errorCode`      | string?   | Stable machine-readable code present only when `status >= 400`.                |
| `request_id`     | string    | Request identifier from the correlation context.                            |
| `correlation_id` | string    | Correlation identifier from the correlation context.                        |

Access events contain no PEI: neither the request body nor recipient addresses are recorded.

### `/api/streams` error codes

| Status | `errorCode`             | When                                                     |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| 400   | `INVALID_REQUEST`       | Malformed JSON or malformed cursor parameter.                              |
| 409   | `IDEMPOTENCY_CONFLICT` x Idempotency key reused with a different payload.                              |
| 422   | `VALIDATION_ERROR`      | Request failed schema validation (e.g. bad `limit`).                        |
| 429   | `RATE_LIMITED_EXCEEDED` | Rate limiter short-circuited the request.                                    |
| 500   | `INTERNAL_ERROR`       | Unexpected handler failure.                                                |
| 504   | `GATEWAY_TIMEOUT`     | Route timeout enforced by `withRouteTimeout`.                               |

### Example

```json
{
  "method": "POST",
  "path": "/api/streams",
  "status": 201,
  "durationMs": 12,
  "request_id": "req_01H6ZW8NR2K4T3",
  "correlation_id": "corr_01H6ZW8NR2K4T3"
}
```

```json
{
  "method": "POST",
  "path": "/api/streams",
  "status": 400,
  "durationMs": 3,
  "errorCode": "INVALID_REQUEST",
  "request_id": "req_01H6ZW8NR2K4T3",
  "correlation_id": "corr_01H6ZW8NR2K4T3"
}
```

### Guarantees

- Exactly one access event per request, including when the rate limiter short-circuits and on 304.
- Timeouts produced by `withRouteTimeout` emit a single event with `errorCode: "GATEWAY_TIMEOUT"`; the
  wrapper does not emit a duplicate.
- Logging is non-blocking: the hot path never awaits the access logger.
