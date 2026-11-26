# Stream list pagination cursors

`GET /api/streams` and `GET /api/v2/streams` return a `meta.nextCursor` value
that a client sends back as the `cursor` query parameter to fetch the next
page.

## Cursor format

| Version | Format | Example |
| --- | --- | --- |
| Before | `base64(<stream id>)` | `c3RyZWFtLWFkYQ==` |
| Now | `base64(<createdAt>|<id>)` | `MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafHN0cmVhbS1hZGM=` |

The cursor is a *keyset* cursor: it carries the `(createdAt, id)` pair of the
last row of the previous page, not an offset. The stream list is sorted by
`(createdAt, id)`, and the next page contains every row that sorts strictly
after that pair.

## Why the format changed

The old cursor was decoded with `Buffer.from(cursor, "base64")`, which never
throws:

- a malformed cursor decoded to a junk id, so the `INVALID_CURSOR` branch was
  unreachable;
- an id that no longer existed (the stream was deleted between two pages) fell
  through and returned **page one again**, so a client walking the pages could
  loop forever or see duplicates.

The keyset cursor fixes both:

- the payload is validated strictly (canonical base64, an ISO-8601 timestamp
  and a safe id), so a malformed cursor is rejected with `422 INVALID_CURSOR`;
- the position does not depend on the row still existing, so a deleted row does
  not restart the listing;
- the comparison is a total order, so a row inserted while the client walks the
  pages is never returned twice.

## Legacy cursors

Plain-id cursors are still accepted for one release, but only when the stream
they point at still exists. Their use is logged as a deprecation warning:

```
Deprecated plain-id pagination cursor used
```

They are removed in the next release. Clients must send the `meta.nextCursor`
value they received.

## Errors

| Situation | Status | Code |
| --- | --- | --- |
| Cursor is not canonical base64 | `422` | `INVALID_CURSOR` |
| Cursor is not a keyset cursor | `422` | `INVALID_CURSOR` |
| Legacy cursor for a deleted stream | `422` | `INVALID_CURSOR` |
| `limit` is not an integer in `[1, 100]` | `422` | `VALIDATION_ERROR` (v1), `INVALID_LIMIT` (v2) |
| `status` is not a known stream status | `422` | `VALIDATION_ERROR` (v1), `INVALID_STATUS` (v2) |

## RFC 8288 `Link` header

Cursor-paginated list endpoints (`GET /api/streams`, `GET /api/v2/streams`, and `GET /api/activity`) emit a standards-based RFC 8288 `Link` response header so generic HTTP clients can traverse pages without parsing the JSON body:

```http
Link: </api/v2/streams?limit=20&status=active&cursor=MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafHN0cmVhbS0x>; rel="next", </api/v2/streams?limit=20&status=active>; rel="self"
```

- `rel="next"` is included whenever another page is available (`meta.hasNext === true`) and omitted on the final page.
- `rel="self"` echoes the current page URI with all active query parameters preserved (including `limit`, filters such as `status`, and the current `cursor` if supplied).
- `rel="prev"` is intentionally omitted because the underlying keyset cursor `(createdAt, id)` is forward-only.
- Cursors are URL-encoded in the link target URI, and all other query parameters are preserved.
- On `GET /api/streams` and `GET /api/v2/streams`, the `Link` header is preserved on `304 Not Modified` responses alongside `ETag`.
- `Link` is listed in `Access-Control-Expose-Headers` so browser clients can read it on cross-origin responses.
