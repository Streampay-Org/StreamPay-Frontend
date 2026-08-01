# GET /api/webhooks — ETag / 304 (v7)

**Issue:** [#1110](https://github.com/Streampay-Org/StreamPay-Frontend/issues/1110) Add ETag/304 on /api/webhooks (v7)  
**Campaign:** GrantFox FWC26 Campaign (Stellar Wave)  

---

## Overview

`GET /api/webhooks` (Prometheus metrics scrape) now emits a **strong ETag** (SHA-256 of the exact metrics body bytes) and honours conditional requests via `If-None-Match`.

## Behaviour

| Request | Response |
| ------- | -------- |
| First `GET` | `200` + Prometheus text body + `ETag: "<64-hex>"` + `Cache-Control: public, max-age=0, must-revalidate` |
| `If-None-Match` matches current ETag | `304 Not Modified` (empty body, same ETag / Cache-Control) |
| Metrics contents change | `200` with a new ETag |

Implementation uses `withStrongEtagBody` from `src/middleware/etag.ts` so the Prometheus `Content-Type` is preserved (unlike the JSON-oriented `withStrongEtag` helper).

## Visible / API changes

- Response headers on successful scrape: `etag`, `cache-control`
- Rate limits, metrics body shape, and `Content-Type` are unchanged

## Verification

```bash
npx jest app/api/webhooks/webhooks.etag.test.ts app/api/webhooks/route.test.ts src/middleware/etag.test.ts --no-coverage
```
