# GET /api/exports — ETag / 304 (v7)

**Issue:** [#1120](https://github.com/Streampay-Org/StreamPay-Frontend/issues/1120) Add ETag/304 on /api/exports (v7)  
**Campaign:** GrantFox FWC26 Campaign (Stellar Wave)  

---

## Overview

`GET /api/exports` now emits a **strong ETag** (SHA-256 of the canonical JSON payload) and honours conditional requests via `If-None-Match`.

## Behaviour

| Request | Response |
| ------- | -------- |
| First `GET` (authenticated) | `200` + body + `ETag: "<64-hex>"` + `Cache-Control: public, max-age=0, must-revalidate` |
| `If-None-Match` matches current ETag | `304 Not Modified` (empty body, same ETag / Cache-Control) |
| List contents change (new/updated jobs) | `200` with a new ETag |

Implementation reuses `withStrongEtag` from `src/middleware/etag.ts` (same helper as `/api/reconciliation`).

## Visible / API changes

- Response headers on successful list: `etag`, `cache-control`
- Auth, rate limits, cursor pagination, validation, and JSON body shape are unchanged

## Verification

```bash
npx jest app/api/exports/exports.etag.test.ts app/api/exports/exports.test.ts --no-coverage
```
