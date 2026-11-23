# Activity feed

`GET /api/activity` returns a page of activity visible to the authenticated
wallet. Events are ordered newest first by timestamp, then by event ID.

## Authentication and rate limit

Send a valid bearer token in the `Authorization` header. The route authenticates
the request with `tryAuthenticateRequest`; requests without a valid token receive
`401 UNAUTHORIZED`.

The endpoint uses the `read` rate-limit class: 60 requests per minute. A
throttled request receives `429`.

## Query parameters

All parameters are optional.

| Parameter | Description | Default and validation |
| --- | --- | --- |
| `cursor` | Opaque keyset cursor from the preceding response's `meta.nextCursor`. | Omit for the first page; an empty value is also treated as omitted. A malformed non-empty cursor returns `422 INVALID_CURSOR`. |
| `streamId` | Return events for this stream only. | Must contain only letters, digits, `.`, `_`, `:`, or `-`; otherwise `422 INVALID_STREAM_ID`. A stream not found or not owned by the caller returns `404 STREAM_NOT_FOUND`. |
| `type` | Return events of this type only. | Must be one of the event types listed below; an unknown type returns `422 INVALID_TYPE`. |
| `limit` | Maximum number of events in the page. | Defaults to `20`; must be an integer from `1` to `100` inclusive. Invalid values return `422 INVALID_LIMIT`. |

Validation errors use a JSON error envelope, for example:

```json
{
  "error": {
    "code": "INVALID_LIMIT",
    "message": "limit must be an integer between 1 and 100",
    "request_id": "..."
  }
}
```

## Event types

| Type | Meaning |
| --- | --- |
| `wallet.connected` | A wallet connected. |
| `wallet.disconnected` | A wallet disconnected. |
| `stream.created` | A stream was created. |
| `stream.started` | A stream started sending funds. |
| `stream.paused` | A stream was paused. |
| `stream.resumed` | A paused stream resumed. |
| `stream.stopped` | A stream was stopped. |
| `stream.settled` | A stream was settled. |
| `stream.ended` | A stream reached its end. |
| `stream.cancelled` | A stream was cancelled. |
| `stream.withdrawn` | Funds were withdrawn from a stream. |
| `stream.updated` | A stream's details were updated. |
| `stream.deleted` | A stream was deleted. |
| `funds.withdrawn` | Funds were withdrawn from the wallet. |

## Visibility and deleted streams

Stream events are visible to the current stream sender or recipient. Wallet and
other non-stream events are visible to the wallet recorded as the event actor.
If a stream event's stream record no longer exists, it is visible only when its
recorded actor is the authenticated wallet; the returned entry is marked
`isDeleted: true`.

Filtering, totals, and pagination are applied to the caller-visible events.
Requesting a `streamId` that is missing or not owned by the caller returns
`404 STREAM_NOT_FOUND`.

## Response and pagination

The response contains the events in `data` and pagination metadata in `meta`:

```json
{
  "data": [],
  "meta": {
    "hasNext": true,
    "nextCursor": "<opaque cursor>",
    "total": 42
  },
  "links": {
    "self": "/api/activity?limit=20"
  }
}
```

When `meta.hasNext` is true, pass `meta.nextCursor` as the `cursor` parameter
to fetch the next page. Keep any filters and page size from the first request:

```js
const params = new URLSearchParams({ limit: "20" });
let response = await fetch(`/api/activity?${params}`, {
  headers: { Authorization: `Bearer ${token}` },
});
let page = await response.json();

while (page.meta.hasNext) {
  params.set("cursor", page.meta.nextCursor);
  response = await fetch(`/api/activity?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  page = await response.json();
  // Process page.data
}
```

The cursor represents the last event's timestamp and ID, encoded as an opaque
keyset position. Treat it as a value to return unchanged rather than constructing
one yourself. When there are no more pages, `hasNext` is `false` and
`nextCursor` is `null`.
