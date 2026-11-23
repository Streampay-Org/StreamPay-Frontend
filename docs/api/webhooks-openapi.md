# OpenAPI examples — `/api/webhooks`

## Overview
`src/openapi.yaml` now documents **request/response examples** for the
webhooks surface:

- `GET` / `POST` `/api/webhooks` (Prometheus scrape + event receiver)
- `POST` `/api/webhooks/dlq`
- `GET` `/api/webhooks/deliveries`

## Examples added
- Metrics text sample for `GET /api/webhooks`
- `payment.received` request body + `success: true` response
- Standardized `INVALID_INPUT` / `INTERNAL_ERROR` error envelopes
- DLQ acknowledge (`received: true`) and deliveries list page

## Testing
`__tests__/openapi-webhooks.test.ts` asserts path presence and concrete
`examples` blocks for the statuses above.
