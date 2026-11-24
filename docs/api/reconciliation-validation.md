# /api/reconciliation Input Validation (v7)

**Issue:** [#1136](https://github.com/Streampay-Org/StreamPay-Frontend/issues/1136) Add input validation for /api/reconciliation (v7)  
**Campaign:** GrantFox FWC26 Campaign (Stellar Wave)  

---

## Overview

`GET /api/reconciliation` validates query params at the boundary with a Zod schema in `src/validators/reconciliation.ts`. Failures return the standard **422 `VALIDATION_ERROR`** envelope with per-field `details` and a correlation `request_id`, matching `/api/streams` and `/api/auth/wallet`.

## Query schema

| Param | Rules | Notes |
| ----- | ----- | ----- |
| `limit` | Optional. Integer **1–1000** (default **100** when omitted) | Malformed / out-of-range → 422 |
| `cursor` | Optional. Non-empty string when present | Empty / whitespace → 422 |
| `status` | Optional. One of `pending`, `completed`, `failed` | Unknown → 422; filters mock rows when set |

Unknown query params are ignored.

## Behaviour change

- Invalid `limit` previously returned **400 `INVALID_INPUT`**. It now returns **422 `VALIDATION_ERROR`** with `details[].field === "limit"`.

## Example error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "details": [
      { "field": "limit", "code": "CUSTOM", "message": "must be an integer between 1 and 1000" }
    ],
    "request_id": "…"
  }
}
```

## Verification

```bash
npx jest src/validators/reconciliation.test.ts app/api/reconciliation/route.test.ts --no-coverage
```
