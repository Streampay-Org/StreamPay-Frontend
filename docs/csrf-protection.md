# CSRF Protection Reference

To protect our API endpoints against Cross-Site Request Forgery (CSRF) attacks (especially when using cookie-based authentication), we implement a stateless **Double-Submit Cookie** pattern enforced at the middleware level.

## How it works

1. **Token Generation (Safe Requests)**
   - When a client issues a safe request (e.g., `GET`, `HEAD`, `OPTIONS`) to any `/api/*` endpoint (excluding webhooks), the middleware checks if a valid `csrf-token` cookie is present.
   - If the cookie is absent or does not contain a valid cryptographically secure 32-byte hex token (64 characters), the middleware generates a new token and sets it as a non-HttpOnly cookie named `csrf-token`.
   - The cookie is marked as `SameSite=Lax`, and `Secure` is enabled in production. It is not HttpOnly so that client-side JavaScript can read it.

2. **Token Verification (State-Changing Requests)**
   - For all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) to `/api/*` endpoints (excluding webhooks), the middleware extracts:
     - The CSRF token from the `csrf-token` cookie.
     - The CSRF token from the `x-csrf-token` request header.
   - The middleware verifies that both tokens are present, valid, and exactly identical using a constant-time comparison helper to prevent timing attacks.
   - If validation fails, the request is aborted early with a `403 Forbidden` response and a standard error envelope.

## API Configuration

- **CSRF Cookie Name**: `csrf-token` (`__Host-csrf-token` in production)
- **CSRF Header Name**: `x-csrf-token`
- **Protected Paths**: `/api/*`
- **Exempt Paths**: `/api/webhooks/*` (external webhook deliveries authenticated via signatures)

## Credential-less API clients

CSRF only threatens requests that carry **ambient** credentials, i.e. cookies
that a browser attaches automatically. Server-to-server integrations that
authenticate with `Authorization: Bearer …` or `X-API-Key` cannot be forged
by another origin, so the double-submit token is not required for them.

The middleware therefore skips the CSRF check when **all** of the following
hold:

1. the request method is state-changing (`POST`, `PUT`, `PATCH`, `DELETE`);
2. the request carries **no** `Cookie` header at all;
3. the request carries an `Authorization: Bearer …`
   or a non-empty `X-API-Key` header.

A request that carries any cookie is always checked, even when it also
carries a bearer token, so browser sessions keep the full double-submit
protection.

## Cookie hardening

- In production the cookie is named `__Host-csrf-token`. Browsers only accept
  a `__Host-` cookie when it is `Secure`, has `Path=/` and has no `Domain`
  attribute, which prevents a sub-domain from setting ("cookie tossing") a
  token the app would trust.
- The legacy `csrf-token` name is still **read** for one release so existing
  sessions migrate without a logout.
- Token generation requires a cryptographically secure random source
  (`crypto.getRandomValues`); there is no `Math.random()` fallback.

## Same-origin requests and the CORS gate

`middleware.ts` decides the CORS outcome through the shared
`buildCorsDecision()` helper in `app/lib/cors.ts`:

| `Origin` header                    | Decision      | Result                          |
| ---------------------------------- | ------------- | ------------------------------- |
| absent                             | `none`        | request proceeds                |
| equals the request origin          | `same-origin` | request proceeds, no CORS headers |
| listed in `ALLOWED_ORIGINS`        | `allowed`     | CORS headers are sent            |
| `null`                             | `null-origin` | `403 CORS_ORIGIN_NULL`          |
| anything else                      | `denied`      | `403 CORS_ORIGIN_DISALLOWED`    |

Same-origin requests skip the allowlist, because browsers send `Origin` on
same-origin writes and deployment URLs (for example Vercel preview URLs) are
frequently not listed in `ALLOWED_ORIGINS`. Allowed cross-origin responses
also expose `x-request-id`, `retry-after` and `etag`, and merge — instead of
overwrite — the `Vary` header.

## Error Response Shape

When CSRF validation fails, the middleware returns an HTTP `403 Forbidden` response containing a standardized error envelope:

```json
{
  "error": {
    "code": "CSRF_TOKEN_INVALID",
    "message": "CSRF token validation failed.",
    "request_id": "req_..."
  }
}
```

## Implementation Guidelines

- **Frontend Integration**:
  Before sending any state-changing request (e.g., when initiating stream creation, modification, or wallet authentication), the frontend must read the `csrf-token` cookie (e.g., via `document.cookie` or a client helper) and attach its value in the request headers under `x-csrf-token`.
