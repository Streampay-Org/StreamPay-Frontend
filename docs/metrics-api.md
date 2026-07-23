# Metrics API Documentation

## Overview

The `/api/metrics` endpoint provides Prometheus-formatted metrics for monitoring and observability of the StreamPay application. This endpoint is token-gated using internal service authentication to prevent unauthorized access to sensitive metrics data.

## Endpoint

```
GET /api/metrics
```

## Authentication

This endpoint requires internal service authentication using HMAC signatures. The following services are authorized to access metrics:

- `prometheus` - Prometheus monitoring service
- `monitoring` - Generic monitoring services
- `ops-automation` - Operations automation tools

### Authentication Headers

The request must include the following headers:

- `x-streampay-content-sha256` - SHA256 hash of the request body
- `x-streampay-key-id` - The key identifier for the service
- `x-streampay-service-name` - The name of the service making the request
- `x-streampay-signature` - HMAC signature of the canonical request (format: `v1=<signature>`)
- `x-streampay-timestamp` - Unix timestamp in milliseconds

### Authentication Flow

1. Service generates canonical request string
2. Service signs the canonical request with its secret key using HMAC-SHA256
3. Service includes signature and metadata in request headers
4. Server verifies signature, timestamp, and service authorization
5. If valid, metrics are returned; otherwise, 401/403 error is returned

## Response Format

### Success Response

**Status Code:** `200 OK`

**Content-Type:** `text/plain; version=0.0.4`

**Headers:**
- `X-Correlation-ID` - Unique identifier for the request

**Body:** Prometheus-formatted metrics text

Example response:
```
# HELP streampay_streams_total Total number of streams in the system
# TYPE streampay_streams_total gauge
streampay_streams_total{correlation_id="metrics_1234567890_abc123"} 42 1719072000

# HELP streampay_streams_active Number of active streams
# TYPE streampay_streams_active gauge
streampay_streams_active{correlation_id="metrics_1234567890_abc123"} 15 1719072000

# HELP streampay_streams_ended Number of ended streams
# TYPE streampay_streams_ended gauge
streampay_streams_ended{correlation_id="metrics_1234567890_abc123"} 20 1719072000

# HELP streampay_streams_paused Number of paused streams
# TYPE streampay_streams_paused gauge
streampay_streams_paused{correlation_id="metrics_1234567890_abc123"} 5 1719072000

# HELP streampay_streams_withdrawn Number of withdrawn streams
# TYPE streampay_streams_withdrawn gauge
streampay_streams_withdrawn{correlation_id="metrics_1234567890_abc123"} 2 1719072000

# HELP streampay_streams_draft Number of draft streams
# TYPE streampay_streams_draft gauge
streampay_streams_draft{correlation_id="metrics_1234567890_abc123"} 0 1719072000

# HELP streampay_failed_withdrawals_total Total number of failed withdrawals
# TYPE streampay_failed_withdrawals_total gauge
streampay_failed_withdrawals_total{correlation_id="metrics_1234567890_abc123"} 3 1719072000
```

### Error Responses

**Authentication Failure (401 Unauthorized)**
```json
{
  "error": {
    "code": "INTERNAL_AUTH_REQUIRED",
    "message": "Signed service-to-service authentication headers are required.",
    "request_id": "mock-request-id"
  }
}
```

**Service Not Allowed (403 Forbidden)**
```json
{
  "error": {
    "code": "SERVICE_NOT_ALLOWED",
    "message": "Service 'unauthorized-service' is not allowed to call this route.",
    "request_id": "mock-request-id"
  }
}
```

**Internal Error (500 Internal Server Error)**
```json
{
  "error": {
    "code": "METRICS_ERROR",
    "message": "Failed to generate metrics",
    "request_id": "metrics_1234567890_abc123"
  }
}
```

## Metrics

### Stream Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `streampay_streams_total` | gauge | Total number of streams in the system |
| `streampay_streams_active` | gauge | Number of streams with status "active" |
| `streampay_streams_ended` | gauge | Number of streams with status "ended" |
| `streampay_streams_paused` | gauge | Number of streams with status "paused" |
| `streampay_streams_withdrawn` | gauge | Number of streams with status "withdrawn" |
| `streampay_streams_draft` | gauge | Number of streams with status "draft" |
| `streampay_failed_withdrawals_total` | gauge | Total number of streams with failed withdrawals |

### Labels

All metrics include the following label:

- `correlation_id` - Unique identifier for the metrics request (useful for tracing)

## Usage Examples

### Using curl with Internal Service Auth

```bash
#!/bin/bash

# Configuration
KEY_ID="your-key-id"
SECRET="your-secret-key"
SERVICE_NAME="prometheus"
URL="http://localhost:3000/api/metrics"

# Generate timestamp
TIMESTAMP_MS=$(date +%s)000

# Generate body hash (empty for GET requests)
BODY=""
BODY_SHA256=$(echo -n "$BODY" | sha256sum | cut -d' ' -f1)

# Build canonical request
CANONICAL_REQUEST="streampay-hmac-v1
GET
/api/metrics
$SERVICE_NAME
$KEY_ID
$TIMESTAMP_MS
$BODY_SHA256"

# Sign the request
SIGNATURE=$(echo -n "$CANONICAL_REQUEST" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Make the request
curl -X GET "$URL" \
  -H "x-streampay-content-sha256: $BODY_SHA256" \
  -H "x-streampay-key-id: $KEY_ID" \
  -H "x-streampay-service-name: $SERVICE_NAME" \
  -H "x-streampay-signature: v1=$SIGNATURE" \
  -H "x-streampay-timestamp: $TIMESTAMP_MS"
```

### Using Node.js with Internal Service Auth

```typescript
import { createInternalServiceRequestHeaders } from "@/app/lib/internal-service-auth";

const headers = createInternalServiceRequestHeaders({
  keyId: "your-key-id",
  secret: "your-secret-key",
  serviceName: "prometheus",
  method: "GET",
  url: "http://localhost:3000/api/metrics",
});

const response = await fetch("http://localhost:3000/api/metrics", {
  method: "GET",
  headers,
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
    # Configure bearer token or use a relayer with internal auth
    bearer_token: 'your-auth-token'
    static_configs:
      - targets: ['localhost:3000']
```

## Security Considerations

1. **Token Gating**: The endpoint is protected by internal service authentication to prevent unauthorized access
2. **Service Whitelist**: Only specific services (prometheus, monitoring, ops-automation) are allowed
3. **Clock Skew Protection**: Timestamps must be within the allowed clock skew window (default: 300 seconds)
4. **Signature Verification**: All requests are verified using HMAC-SHA256 signatures
5. **Audit Logging**: All metrics access is logged with correlation IDs for audit trails

## Structured Logging

The endpoint logs both successful access and errors with structured JSON:

### Access Log
```json
{
  "event": "metrics_access",
  "correlation_id": "metrics_1234567890_abc123",
  "service_name": "prometheus",
  "key_id": "key-123",
  "timestamp": "2024-06-27T16:00:00.000Z",
  "metrics": {
    "totalStreams": 42,
    "activeStreams": 15,
    "endedStreams": 20,
    "pausedStreams": 5,
    "withdrawnStreams": 2,
    "draftStreams": 0,
    "failedWithdrawals": 3
  }
}
```

### Error Log
```json
{
  "event": "metrics_error",
  "correlation_id": "metrics_1234567890_abc123",
  "service_name": "prometheus",
  "key_id": "key-123",
  "timestamp": "2024-06-27T16:00:00.000Z",
  "error": "Database connection failed"
}
```

## Testing

The endpoint includes comprehensive tests covering:

- Authentication and authorization
- Metrics generation and formatting
- Error handling
- Structured logging
- Edge cases (empty streams, various stream states)

Run tests with:
```bash
npm test app/api/metrics/route.test.ts
```

## Rate Limiting

Currently, no rate limiting is implemented. Consider adding rate limiting if the endpoint is abused or if Prometheus scraping frequency is too high.

## Future Enhancements

Potential improvements for the metrics endpoint:

1. **Additional Metrics**: Add more granular metrics (e.g., by organization, by time period)
2. **Histograms**: Add histogram metrics for stream amounts, durations, etc.
3. **Custom Labels**: Add support for custom labels (e.g., environment, region)
4. **Caching**: Implement caching to reduce database load
5. **Rate Limiting**: Add rate limiting to prevent abuse
6. **Metrics Filtering**: Allow filtering metrics by query parameters
7. **Health Status**: Include application health status in metrics

## Troubleshooting

### Common Issues

**401 Unauthorized**
- Verify authentication headers are present and correctly formatted
- Check that the key ID is registered in the configuration
- Ensure the timestamp is within the allowed clock skew window

**403 Forbidden**
- Verify the service name is in the allowed services list
- Check that the service is configured with the correct permissions

**500 Internal Server Error**
- Check application logs for error details
- Verify database connectivity
- Ensure stream repository is properly initialized

### Debug Mode

For debugging, you can temporarily set `concealFailure: false` in the `requireInternalServiceAuth` call to get detailed error messages. **Do not use this in production.**
