# Organisations API (`/api/orgs`)

Organisations ("orgs") group wallet addresses under roles and carry the stream
policy that the multi-sig workflow reads (the multi-sig approval workflow).
This page documents the org and member routes and points at the token
allowlist route.

Every response body below was captured from the route handlers in
`app/api/orgs/**`. Org data lives in the in-memory `orgDb`
(`app/lib/org-db.ts`), so it resets when the server restarts.

## Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/orgs` | none | List orgs (member addresses are omitted). |
| `POST` | `/api/orgs` | none | Create an org; `ownerWalletAddress` becomes its `owner`. |
| `GET` | `/api/orgs/{orgId}` | none | Org detail with members, `ownedStreams` and `tokenAllowlist`. |
| `GET` | `/api/orgs/{orgId}/members` | none | List members. |
| `POST` | `/api/orgs/{orgId}/members` | `Actor-Wallet-Address` of an `owner` | Add a member. |
| `GET` `PUT` `POST` `DELETE` | `/api/orgs/{orgId}/token-allowlist` | owner for writes | See [Token allowlist](#token-allowlist). |

## Roles

`OrgRole` (`app/lib/org-types.ts`) is one of `owner`, `pauser`, `settler`,
`viewer`. What each role may do is set by the org's `policy`. New orgs get
`DEFAULT_STREAM_POLICY`:

| Action | owner | pauser | settler | viewer |
| --- | :---: | :---: | :---: | :---: |
| start | yes | yes | | |
| pause | yes | yes | | |
| resume | yes | yes | | |
| settle | yes | | yes | |
| stop | yes | | | |
| withdraw | yes | | yes | |

`policy.requireApprovals` defaults to `1` (settle and stop run immediately).
Set it to `2` to require a second signer, as the seeded `org-acme` does.

## The `Actor-Wallet-Address` header

Owner-only routes identify the caller with the `Actor-Wallet-Address` header.
This is an MVP stand-in for a verified identity (the source notes that
production should use JWT verification). The caller must be a member of the
org with role `owner`; a missing header, an unknown address and a non-owner all
produce `403 FORBIDDEN`.

## `GET /api/orgs`

Lists every org. Member wallet addresses are left out for privacy; only
`memberCount` is returned.

```bash
curl http://localhost:3000/api/orgs
```

```json
{
  "data": [
    {
      "id": "org-beta",
      "name": "Beta Corp",
      "memberCount": 1,
      "policy": {
        "policyVersion": 1,
        "canStart": ["owner", "pauser"],
        "canPause": ["owner", "pauser"],
        "canResume": ["owner", "pauser"],
        "canSettle": ["owner", "settler"],
        "canStop": ["owner"],
        "canWithdraw": ["owner", "settler"],
        "requireApprovals": 1
      },
      "createdAt": "2026-04-05T00:00:00Z",
      "updatedAt": "2026-04-05T00:00:00Z"
    }
  ],
  "meta": { "total": 1 }
}
```

(The real response lists every org; one is shown.)

| Status | Code | When |
| --- | --- | --- |
| 200 | | Success. |
| 504 | `GATEWAY_TIMEOUT` | The handler exceeded `ROUTE_TIMEOUT_MS` (default 10 000 ms). |

## `POST /api/orgs`

Creates an org with a generated id (`org-` plus 8 characters), the default
policy, and one member: `ownerWalletAddress` as `owner`.

| Body field | Type | Required |
| --- | --- | --- |
| `name` | non-empty string | yes |
| `ownerWalletAddress` | non-empty string | yes |

Both values are trimmed. The optional `Idempotency-Key` header makes retries
safe: the same key with the same body replays the original response and adds
`Idempotency-Replay: true`. Without the header every call creates a new org.

```bash
curl -X POST http://localhost:3000/api/orgs \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-gamma-1" \
  -d '{"name":"Gamma","ownerWalletAddress":"GGAMMA"}'
```

```json
{
  "data": {
    "id": "org-0e0351ac",
    "name": "Gamma",
    "members": [
      { "walletAddress": "GGAMMA", "role": "owner", "addedAt": "2026-11-24T02:21:10.315Z" }
    ],
    "policy": {
      "policyVersion": 1,
      "canStart": ["owner", "pauser"],
      "canPause": ["owner", "pauser"],
      "canResume": ["owner", "pauser"],
      "canSettle": ["owner", "settler"],
      "canStop": ["owner"],
      "canWithdraw": ["owner", "settler"],
      "requireApprovals": 1
    },
    "createdAt": "2026-11-24T02:21:10.315Z",
    "updatedAt": "2026-11-24T02:21:10.315Z"
  },
  "links": { "self": "/api/orgs/org-0e0351ac" }
}
```

| Status | Code | When |
| --- | --- | --- |
| 201 | | Org created (also the replayed status for a repeated `Idempotency-Key`). |
| 400 | `INVALID_REQUEST` | Body is not valid JSON. |
| 400 | `IDEMPOTENCY_KEY_INVALID` | `Idempotency-Key` is present but empty, longer than 255 characters, or not printable ASCII. |
| 409 | `IdempotencyKeyReused` | Same key sent with a different body. |
| 409 | `IdempotencyKeyInProgress` | An identical request with this key is still running; retry after the `Retry-After: 1` header. |
| 422 | `VALIDATION_ERROR` | `name` or `ownerWalletAddress` is missing, not a string, or blank. |
| 504 | `GATEWAY_TIMEOUT` | The handler exceeded `ROUTE_TIMEOUT_MS`. |

The two `409` idempotency responses do not use the standard envelope. Their
body is `{ "error": "<code>", "message": "..." }`, with `error` a plain string.

## `GET /api/orgs/{orgId}`

Returns the full org record, including member addresses, plus the ids of the
streams the org owns and its token allowlist (`[]` when unset).

```bash
curl http://localhost:3000/api/orgs/org-beta
```

```json
{
  "data": {
    "id": "org-beta",
    "name": "Beta Corp",
    "members": [
      {
        "walletAddress": "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA",
        "role": "owner",
        "addedAt": "2026-04-05T00:00:00Z"
      }
    ],
    "policy": {
      "policyVersion": 1,
      "canStart": ["owner", "pauser"],
      "canPause": ["owner", "pauser"],
      "canResume": ["owner", "pauser"],
      "canSettle": ["owner", "settler"],
      "canStop": ["owner"],
      "canWithdraw": ["owner", "settler"],
      "requireApprovals": 1
    },
    "createdAt": "2026-04-05T00:00:00Z",
    "updatedAt": "2026-04-05T00:00:00Z",
    "tokenAllowlist": [],
    "ownedStreams": []
  },
  "links": { "self": "/api/orgs/org-beta" }
}
```

| Status | Code | When |
| --- | --- | --- |
| 200 | | Success. |
| 404 | `ORG_NOT_FOUND` | No org with this id. |
| 504 | `GATEWAY_TIMEOUT` | The handler exceeded `ROUTE_TIMEOUT_MS`. |

## `GET /api/orgs/{orgId}/members`

```bash
curl http://localhost:3000/api/orgs/org-beta/members
```

```json
{
  "data": [
    {
      "walletAddress": "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA",
      "role": "owner",
      "addedAt": "2026-04-05T00:00:00Z"
    }
  ],
  "meta": { "total": 1 },
  "links": { "self": "/api/orgs/org-beta/members" }
}
```

| Status | Code | When |
| --- | --- | --- |
| 200 | | Success. |
| 404 | `ORG_NOT_FOUND` | No org with this id. |

## `POST /api/orgs/{orgId}/members`

Adds a member. Only an org `owner` may call it. Checks run in this order: org
exists, caller is an owner, body is read and validated.

| Body field | Type | Required |
| --- | --- | --- |
| `walletAddress` | non-empty string (trimmed) | yes |
| `role` | `owner`, `pauser`, `settler` or `viewer` | yes |

The call is idempotent per wallet: if `walletAddress` is already a member, the
**existing** record is returned with `200` and nothing changes, even when the
request names a different `role`. A new member returns `201`.

```bash
curl -X POST http://localhost:3000/api/orgs/org-beta/members \
  -H "Content-Type: application/json" \
  -H "Actor-Wallet-Address: GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA" \
  -d '{"walletAddress":"GNEW","role":"viewer"}'
```

```json
{
  "data": { "walletAddress": "GNEW", "role": "viewer", "addedAt": "2026-11-24T02:21:10.358Z" }
}
```

| Status | Code | When |
| --- | --- | --- |
| 201 | | Member added. |
| 200 | | `walletAddress` was already a member; the existing record is returned unchanged. |
| 400 | `EMPTY_BODY` | The request body is empty. |
| 400 | `INVALID_REQUEST` | Body is not valid JSON. |
| 403 | `FORBIDDEN` | `Actor-Wallet-Address` is missing, not a member, or not an `owner`. |
| 404 | `ORG_NOT_FOUND` | No org with this id. |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds the `/api/*` limit (256 KB by default, `MAX_STREAM_BODY_BYTES`). |
| 422 | `VALIDATION_ERROR` | `walletAddress` is missing or blank, or `role` is not one of the four roles. |

Error bodies on this route carry the request's correlation id in
`error.request_id` (for example `req_a5df1f13-...`), not the fixed
`mock-request-id` used by the other org routes.

## Token allowlist

`/api/orgs/{orgId}/token-allowlist` manages the per-org list of tokens that
streams owned by the org may use. An empty list means the org inherits the
global allowlist behaviour. `GET` is open; `PUT`, `POST` and `DELETE` need an
owner in `Actor-Wallet-Address`.

| Method | Body | Result |
| --- | --- | --- |
| `GET` | none | `{ data: { orgId, tokens, enabled }, links.self }` |
| `PUT` | `{ "tokens": [...] }` | Replaces the whole list (deduplicated). |
| `POST` | `{ "token": "..." }` | Adds one token: `201` with `added: true`, or `200` with `added: false` if present. |
| `DELETE` | `{ "token": "..." }` | Removes one token: `200` with `removed: true` or `false`. |

Tokens are normalised: `XLM` and `native` become `XLM`, and `CODE:ISSUER`
requires a valid 56-character Stellar issuer key.

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Body is not valid JSON. |
| 403 | `ACTOR_REQUIRED` | Write call without an `Actor-Wallet-Address` header. |
| 403 | `FORBIDDEN` | Caller is not an org `owner`. |
| 404 | `ORG_NOT_FOUND` | No org with this id. |
| 422 | `VALIDATION_ERROR` | `tokens` is not an array of strings, or `token` is missing or blank. |
| 422 | `INVALID_TOKEN` | A token string does not parse. |

## Error envelope

Except where noted above, errors use:

```json
{
  "error": {
    "code": "ORG_NOT_FOUND",
    "message": "Org 'nope' not found.",
    "request_id": "mock-request-id"
  }
}
```
