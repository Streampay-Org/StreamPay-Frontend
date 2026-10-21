# API Client Usage

The `lib/apiClient.ts` module wraps `fetch` with idempotency keys,
timeouts, retry, and error normalisation. Use the typed helpers
(`get`, `post`, `put`, `patch`, `del`) instead of calling `fetch`
directly from React components.

## Basic GET

`GET /api/streams` now returns an `ETag` header and supports `If-None-Match` revalidation. A matching request returns `304 Not Modified` without re-sending the full payload.

```ts
import { get } from '@/lib/apiClient';

type StreamList = { streams: Stream[]; next_cursor: string | null };

const data = await get<StreamList>('/api/v2/streams?limit=20');
```

## POST with body

```ts
import { post } from '@/lib/apiClient';

const created = await post<Stream>('/api/v2/streams', {
  recipient: 'G...',
  amount: '100.0000000',
  asset_code: 'USDC',
  duration_seconds: 86_400,
});
```

`post`, `put`, and `patch` automatically:

- attach `Content-Type: application/json`
- generate an `Idempotency-Key` per request
- generate a unique `x-request-id`
- require a matching `csrf-token` cookie and `x-csrf-token` header for state-changing requests

For browser-based requests, read the `csrf-token` cookie from the response and send it back in the `x-csrf-token` header on subsequent `POST`, `PUT`, `PATCH`, and `DELETE` calls.

## Timeouts and retries

```ts
const data = await get<Page>('/api/exports/large.csv', {}, {
  timeoutMs: 60_000,
  retries: 3,
  retryDelayMs: 500,
  useExponentialBackoff: true,
});
```

Retries only fire on errors the normaliser marks as retryable
(network errors, 408, 429, 502, 503, 504). 4xx client errors short-
circuit immediately.

## One idempotency key per user intent

`fetchWithIdempotency` mints a random `Idempotency-Key` only when the
caller does not supply one. For an operation the user can retry (a button
that shows a “Retry” action after a timeout), generate the key once when
the intent starts and pass the **same** key on every retry:

```ts
type PendingAction = { action: string; key: string };

const pending: PendingAction = {
  action: 'pause',
  key: crypto.randomUUID(),
};

// First attempt and every retry of this intent use `pending.key`.
await fetchWithIdempotency(`/api/streams/${id}/pause`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': pending.key,
  },
  body: JSON.stringify({ action: 'pause' }),
});
```

Rules:

- **One key per user intent.** Starting an action creates the key; retrying
  that same action reuses it so the server can replay the stored response
  instead of executing the action twice.
- **Never share a key across different actions.** A pause and a cancel are
  separate intents and get separate keys, even when they target the same
  stream.
- **Clear the key on success or a non-retryable error.** The next click is a
  new intent and must use a new key. Keep it only while the failure is
  retryable.
- When the response returns the updated resource (for example
  `{ data: stream }`), update local state from it so the UI reflects the new
  status without a full reload.

## Notification preferences

The authenticated notification preferences endpoint is available at
`/api/notifications/preferences`.

```ts
import { get, put } from '@/lib/apiClient';

const { preferences } = await get<{ preferences: NotificationPreferences }>(
  '/api/notifications/preferences',
);

await put('/api/notifications/preferences', {
  email: false,
  inApp: true,
  webhook: false,
  events: {
    streamCreated: true,
    streamCompleted: true,
    streamCancelled: false,
    paymentFailed: true,
    lowBalance: false,
  },
});
```

The response envelope is `{ preferences: ... }` and the request body
accepts only boolean values for the top-level channels and nested event
flags.
## Error handling

All thrown values are `StreamPayError` objects with `code`, `message`,
`status`, and `request_id`. The `request_id` is forwarded to the server
log so you can grep for it when triaging.

```ts
try {
  await post('/api/v2/streams', body);
} catch (err) {
  const e = err as StreamPayError;
  toast.error(`${e.message} (request id: ${e.request_id})`);
}
```
