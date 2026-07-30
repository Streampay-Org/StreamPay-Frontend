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

- **CSRF Cookie Name**: `csrf-token`
- **CSRF Header Name**: `x-csrf-token`
- **Protected Paths**: `/api/*`
- **Exempt Paths**: `/api/webhooks/*` (external webhook deliveries authenticated via signatures)

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
