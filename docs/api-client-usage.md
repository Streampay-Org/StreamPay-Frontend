# API Client Usage

The `lib/apiClient.ts` module wraps `fetch` with idempotency keys,
timeouts, retry, and error normalisation. Use the typed helpers
(`get`, `post`, `put`, `patch`, `del`) instead of calling `fetch`
directly from React components.

Everything below is the contract implemented by `lib/apiClient.ts`
and `lib/accountFetchCoordinator.ts`. `docs/__tests__/api-client-doc.test.ts`
asserts this page against the code, so if the implementation changes and
this page does not, CI fails.

## Behaviour at a glance

| Concern | Value | Source of truth |
| --- | --- | --- |
| Default timeout | **30 000 ms (30 s)** per attempt | `DEFAULT_OPTIONS.timeoutMs` |
| Default retries | **0** — the client does *not* retry unless asked | `DEFAULT_OPTIONS.retries` |
| Default retry delay | **1 000 ms** base | `DEFAULT_OPTIONS.retryDelayMs` |
| Backoff | Exponential: `base × 2^attempt` plus **30 % jitter**, **capped at 30 000 ms** | `calculateRetryDelay` |
| Flat delay | `retryDelayMs` verbatim when `useExponentialBackoff: false` | `calculateRetryDelay` |
| Retry trigger | Only errors the normaliser marks `retry.retryable` | `fetchWithIdempotency` |
| Timeout mechanism | `AbortController` per attempt; the timer is cleared on settle | `fetchWithTimeout` |
| `Idempotency-Key` | Auto-generated **once per call** for `POST`/`PUT`/`PATCH`/`DELETE`; **reused across retries of that call** | `fetchWithIdempotency` |
| `x-request-id` | Auto-generated `req-<uuid>` once per call, same lifetime as the idempotency key | `fetchWithIdempotency` |
| `Accept` | `application/json` unless you override it | `fetchWithIdempotency` |
| `204 No Content` | Resolves to `null` | `fetchWithIdempotency` |
| Non-JSON `2xx` | Resolves to `null` (body is not read) | `fetchWithIdempotency` |
| Errors | Always a normalised `StreamPayError` | `createErrorFromResponse` |

### Retry budget

`retries` counts **additional attempts**, not total attempts. `retries: 3`
means up to 4 HTTP requests. `retries: 0` (the default) means exactly one
request.

With exponential backoff and the defaults (`retryDelayMs: 1000`), the
waits before attempts 1…n are `1000·2^attempt + up to 30 % jitter`, each
clamped to 30 s — roughly 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s …

### Which errors retry

Retryability comes from the error registry, not from the status code
alone. In practice:

- **Retryable:** network failures and timeouts (`NETWORK_*`),
  `408 REQUEST_TIMEOUT`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`,
  `503 SERVICE_UNAVAILABLE`, `504 GATEWAY_TIMEOUT`, `502` and other
  statuses that fall through to `UNKNOWN_ERROR`, plus `409 CONFLICT`
  and `IDEMPOTENCY_CONFLICT`.
- **Not retryable:** `400`, `401`, `403`, `404`, `405`, `422` and any
  other error the registry marks non-retryable. These short-circuit
  immediately, even when `retries > 0`.

One consequence worth knowing: when a response carries an explicit
error envelope, the **backend's** `code` decides retryability, not the
status. A code the client does not recognise normalises to
`UNKNOWN_ERROR`, which *is* retryable — so a new server-side error code
degrades to "retry a few times" rather than "fail fast". Use a code the
registry already knows (`STREAM_NOT_FOUND`, `CONFLICT`,
`INSUFFICIENT_FUNDS`, …) if you want deterministic retry behaviour.

The `maxRetries` recorded in the registry is **advisory** — it is not
consulted by `apiClient`. The `retries` you pass wins.

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
- attach `Accept: application/json`
- generate an `Idempotency-Key` for the call (mutating methods only)
- generate an `x-request-id` for the call

### Idempotency-Key lifetime

This is the part most likely to cause duplicate mutations:

- **One call = one key.** The key is generated before the retry loop and
  the same `Headers` object is reused, so **every retry inside one
  `post`/`put`/`patch`/`del` call sends the identical key**. That is
  what lets the server collapse a retried mutation into the original.
- **A second call = a new key.** Calling `post` again — from a Retry
  button, a refetch, a second submit — generates a *fresh* UUID. The
  server cannot tell those two calls apart, so a user-initiated retry of
  a mutation is **not** deduplicated for you.
- **If you supply the header yourself it is preserved verbatim.** Pass
  `headers: { 'Idempotency-Key': myKey }` and that value is sent on
  every attempt of that call.

So: automatic retries are safe. Your own retry loop is only safe if you
hold the key across attempts.

### Stable keys for user-initiated retries

When a mutation is surfaced with a Retry affordance (for example
`app/components/ErrorToast.tsx` wired to `onRetry`), generate the key
**once at submit time**, keep it in state for the life of the failure,
and pass it on every retry. Regenerating per click replays the
mutation.

```tsx
import { useRef, useState } from 'react';
import { fetchWithIdempotency } from '@/lib/apiClient';
import { ErrorToast } from '@/app/components/ErrorToast';
import type { StreamPayError } from '@/app/lib/errors/types';

function CancelStreamButton({ streamId }: { streamId: string }) {
  const [error, setError] = useState<StreamPayError | null>(null);
  // A ref, not state: the key must survive re-renders and every retry click.
  const idempotencyKey = useRef(crypto.randomUUID());

  const cancel = async () => {
    setError(null);
    try {
      await fetchWithIdempotency(
        `/api/streams/${streamId}/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey.current,
          },
          body: JSON.stringify({ action: 'cancel' }),
        },
        { retries: 2 }, // clientOptions
      );
    } catch (err) {
      setError(err as StreamPayError);
    }
  };

  return (
    <>
      <button onClick={cancel}>Cancel</button>
      {error && (
        <ErrorToast
          error={error}
          onDismiss={() => setError(null)}
          onRetry={cancel}
        />
      )}
    </>
  );
}
```

Note that `ErrorToast` only offers Retry when
`isRetryableError(error.code)` is true, so a retry affordance never
appears for errors that would fail identically.

### x-request-id

Every call carries an `x-request-id` (`req-<uuid>`) unless you provide
one. It is generated once per call and reused across retries, so all
attempts of one call share a correlation id in the server logs. The
error thrown back to you carries the server's request id when the
response includes one, which is what you show in toasts and paste into
support tickets.

## CSRF

`apiClient` does **not** read cookies and does **not** inject a CSRF
header for you. Enforcement lives in `middleware.ts`, using the
double-submit cookie pattern described in
[CSRF Protection Reference](csrf-protection.md):

- Cookie: `csrf-token` (non-HttpOnly, `SameSite=Lax`, `Secure` in
  production, minted on safe requests to `/api/*`).
- Header: `x-csrf-token`, required on `POST`, `PUT`, `PATCH`, and
  `DELETE` to `/api/*`.
- `/api/webhooks/*` is exempt (authenticated by signature).
- A mismatch is rejected with `403 CSRF_TOKEN_INVALID` — a
  non-retryable error, so it will never loop.

Browser callers must read the cookie and echo it in the header:

```ts
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match?.[1] ?? null;
}

const csrf = readCsrfToken();

await post('/api/v2/streams', body, {
  headers: csrf ? { 'x-csrf-token': csrf } : {},
});
```

Server-side callers (`lib/csrf.ts` helpers, route handlers) do not need
this: there is no ambient cookie jar to protect.

## Timeouts and retries

```ts
const data = await get<Page>('/api/exports/large.csv', {}, {
  timeoutMs: 60_000,
  retries: 3,
  retryDelayMs: 500,
  useExponentialBackoff: true,
});
```

The timeout is **per attempt**, not per call. With `timeoutMs: 30000`
and `retries: 3` the worst case is roughly 4 × 30 s of network time plus
the backoff sleeps, so a timeout budget that matters to the user should
be enforced by the caller as well.

On timeout the in-flight `fetch` is aborted and the error is normalised
to `NETWORK_TIMEOUT`, which is retryable.

## Account-scoped requests

`fetchForAccount` binds a request to one account id so a response can
never be attributed to the wrong account after a switch.

```ts
import { fetchForAccount, AccountSwitchedError } from '@/lib/apiClient';

const streams = await fetchForAccount<StreamList>(
  activeAccountId,
  '/api/v2/streams?limit=20',
);
```

Semantics (`lib/accountFetchCoordinator.ts`):

- If `accountId` is not the active account **at call time**, it throws
  `AccountSwitchedError` immediately — no request is sent.
- If the account switches **while the request or a retry is in flight**,
  the request is aborted and `AccountSwitchedError` is thrown. Late
  responses are discarded rather than rendered against the new account.
- Concurrent calls with the same `accountId` **and** the same dedup key
  (`"<METHOD>:<url>"`) share a single in-flight promise. Two components
  asking for `GET /api/v2/streams` at once produce one HTTP request.
  The dedup key ignores the body, so treat differing bodies under the
  same URL as one request.
- Retries are re-checked against the active account before and after
  every attempt; an account switch aborts a pending backoff sleep
  instead of waiting it out.

Two things to know before turning retries on here:

1. `fetchForAccount` passes `retries`, `retryDelayMs`, `timeoutMs`, and
   `useExponentialBackoff` to **both** the coordinator and the inner
   `fetchWithIdempotency`, so retries can nest. The coordinator's cap on
   the exponential wait is 10 s (no jitter), while the inner client's cap
   is 30 s (with jitter). If you need a predictable retry budget, set
   `retries` once and keep the values identical on both layers — which
   passing `clientOptions` to `fetchForAccount` already does for you.
2. Because the coordinator re-invokes the fetcher per attempt, **each
   coordinator-level retry of a mutating request generates a new
   `Idempotency-Key`**. Nested retries of a mutation therefore are *not*
   key-stable. For mutations that must survive a retry, pass your own
   `Idempotency-Key` header and prefer the plain verb helpers.

Always handle `AccountSwitchedError` — it is a thrown `Error`, not a
`StreamPayError`, and it is not a failure worth showing to the user:

```ts
try {
  await fetchForAccount(id, '/api/v2/streams');
} catch (err) {
  if (err instanceof AccountSwitchedError) return; // stale render, ignore
  throw err;
}
```

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
`status`, `retry.retryable`, and `request_id`. The `request_id` is
forwarded to the server log so you can grep for it when triaging.

```ts
try {
  await post('/api/v2/streams', body);
} catch (err) {
  const e = err as StreamPayError;
  toast.error(`${e.message} (request id: ${e.request_id})`);
}
```

Only `StreamPayError` is guaranteed. `fetchForAccount` can also throw
`AccountSwitchedError`, which is not one — see the section above.

## Checklist for new call sites

- Are you using a helper (`get`/`post`/`put`/`patch`/`del`/
  `fetchForAccount`) rather than raw `fetch`?
- If the mutation can be retried by the user, is the
  `Idempotency-Key` generated once and reused on every retry?
- Is `retries` set deliberately, remembering the default is `0`?
- Is the CSRF token echoed in `x-csrf-token` for browser mutations?
- Is `AccountSwitchedError` handled on `fetchForAccount` call sites?