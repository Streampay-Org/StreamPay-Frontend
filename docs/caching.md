# HTTP Caching (ETag / 304 Short-Circuit)

`GET /api/streams/[id]` supports HTTP-level caching via the `ETag` response
header and the `If-None-Match` request header (RFC 7232). Clients that supply
the most recent ETag receive a `304 Not Modified` with no response body,
saving bandwidth and skipping JSON serialization work on the hot path.

## Response Headers

`GET /api/streams/{id}` always carries the following headers on a 200/304
response:

| Header | Value | Purpose |
| --- | --- | --- |
| `ETag` | Strong, double-quoted SHA-256 hex digest | Opaque version identifier for the stream representation. |
| `Cache-Control` | `private, max-age=0, must-revalidate` | Forces revalidation via ETag on every request; marks the response as tenant-private so shared caches must not reuse it. |
| `X-Cache` | `HIT` or `MISS` | Observability for the in-memory `streamCache` short-circuit. `HIT` means the body came from the in-process `streamCache`; `MISS` means we hit the persistence store. |

### ETag Construction

The tag is the SHA-256 hex digest of:

```
tenant=<x-tenant-id>
<canonical JSON of the stream object>
```

Object keys are emitted in sorted order so two semantically equal
representations always hash to the same value regardless of property order.
The tenant is part of the digest so the same `id` owned by two different
tenants yields two distinct ETags. This prevents cross-tenant cache poisoning
through shared proxies.

## Request Validation: `If-None-Match`

`If-None-Match` is honored per RFC 7232 §3.2:

- **`*`** — matches when the resource exists. Returns `304`.
- **`<etag>`** — strong tag match returns `304`.
- **`W/<etag>`** — weak comparison applies (the `W/` prefix is stripped).
- **Comma-separated lists** — matches if *any* entry matches.
- **Malformed values** — silently treated as a non-match; the request falls
  through to a normal `200`.

On a match the server returns `304 Not Modified` with **no body**, but it
still emits the cache-directive headers so the client can update its
freshness bookkeeping (`ETag`, `Cache-Control`, `X-Cache`).

On a non-match the server returns `200 OK` with the full JSON body and the
current `ETag`.

## Cache Invalidation on Mutation

`POST /api/streams/{id}` and `DELETE /api/streams/{id}` both call
`streamCache.invalidate(tenant, id)` before returning, which drops the
in-process entry. The next `GET` will rebuild from the persistence store and
emit a fresh `ETag`. Because `updatedAt` is updated on every successful
`POST`, even a no-op body change produces a new ETag if the timestamp tick
advances.

## Example Session

```http
GET /api/streams/stream-ada HTTP/1.1
x-tenant-id: org-acme
```

```http
HTTP/1.1 200 OK
ETag: "5f9c…64hex"
Cache-Control: private, max-age=0, must-revalidate
X-Cache: MISS
Content-Type: application/json

{"data": {…},"links":{"self":"/api/v1/streams/stream-ada"}}
```

```http
GET /api/streams/stream-ada HTTP/1.1
x-tenant-id: org-acme
If-None-Match: "5f9c…64hex"
```

```http
HTTP/1.1 304 Not Modified
ETag: "5f9c…64hex"
Cache-Control: private, max-age=0, must-revalidate
X-Cache: HIT
```

## Security Considerations

- **Tenant scoping.** ETag digest inputs include the tenant id, so a
  cross-tenant replay cannot reuse another tenant's tag.
- **Response privacy.** `Cache-Control: private` forbids shared caches
  (CDNs, corporate proxies) from reusing the response.
- **No secret leakage.** ETags are computed from the public stream
  representation only; no auth tokens, secrets, or request bodies feed the
  hash.
- **Tolerated malformed input.** Garbage in `If-None-Match` simply misses
  rather than erroring — the request falls back to `200`.

## Testing

The behavior is covered by:

- **`app/lib/etag.test.ts`** — unit tests for `canonicalize`,
  `computeETag`, and `ifNoneMatchMatches` (determinism, tenant isolation,
  wildcard, weak comparison, malformed input).
- **`app/api/streams/[id]/route.test.ts`** — route-level tests:
  header emission, 200↔304 transitions, weak-tag matching, wildcard
  matching, mutation invalidation, and cross-tenant ETag isolation.

Run them with:

```bash
npm test -- --testPathPattern="(streams/\[id\]/route|etag)"
```
