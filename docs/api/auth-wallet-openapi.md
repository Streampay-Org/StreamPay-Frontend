# OpenAPI examples — `/api/auth/wallet`

## Overview
`src/openapi.yaml` now documents **request/response examples** for
`GET` and `POST` `/api/auth/wallet` (wallet challenge + token exchange).

## Examples added
- **GET 200** — `walletChallenge` (`challenge`, `expires_at`)
- **GET 400 / 422 / 429** — standardized error envelopes with `request_id`
- **POST requestBody** — `verifySignature` payload
- **POST 200** — `walletToken` (`token`, `expires_at`)
- **POST 400 / 401 / 422 / 429** — error envelopes

## Testing
`__tests__/openapi-auth-wallet.test.ts` asserts path presence and that each
documented status includes a concrete `examples` block.
