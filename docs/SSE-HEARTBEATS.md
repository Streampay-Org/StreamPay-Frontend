# Bounded SSE Heartbeats and Dead-Client Detection

## Audience

Integrators and contributors working on the long-lived SSE endpoints:

- `GET /api/indexer/sse`
- `GET /api/streams/events`
- `GET /api/streams/:id/events`

## Guarantees (issue #1372)

Every SSE connection is bounded and self-cleaning:

1. **Bounded heartbeats** — keep-alive heartbeat comments (`: heartbeat N`)
   are written on a fixed cadence, but never more than `SSE_HEARTBEAT_MAX`
   times. An abandoned client cannot pin an open connection (and its timers /
   event-bus listeners) forever.
2. **Dead-client detection** — the connection is closed exactly once as soon
   as any of these happens:
   - the client disconnects (request `abort` signal);
   - the underlying stream rejects a write (dead client / dropped connection);
   - the connection exceeds its idle budget (`SSE_MAX_IDLE_MS` without a
     successful write).
3. **Bounded lifetime** — data events can additionally be bounded
   (`SSE_MAX_EVENTS`, used by the indexer endpoint).
4. **Exactly-once cleanup** — closing clears heartbeat/idle timers, detaches
   the abort listener, removes event-bus subscriptions, closes the stream, and
   reports the close reason + counters once for diagnostics/metrics.

## Shared implementation

All three routes use `createSseConnection()` from `app/lib/sse.ts`. The helper
owns the `ReadableStreamDefaultController`: routes call `send()` to emit data
events and never close the controller themselves.

## Configuration (env-tunable per request)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SSE_HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat cadence. `0` disables heartbeats. |
| `SSE_HEARTBEAT_MAX` | `120` | Maximum heartbeats before the server closes the stream (≈1 h at 30 s). |
| `SSE_MAX_IDLE_MS` | `120000` | Close after this much idle time with no successful write. |
| `SSE_MAX_EVENTS` | `720` | Indexer only: maximum data events per connection (≈1 h at 5 s). |
| `SSE_INTERVAL_MS` | `5000` | Indexer only: status-tick cadence. |

## Behavior notes

- The indexer endpoint's status ticks already act as keep-alives, so it does
  not emit separate heartbeat comments; it still gets the idle deadline,
  max-events bound, and abort/rejected-write detection from the helper.
- Heartbeat comments are SSE comment frames: they keep the connection alive
  and are visible on the wire but dispatch no event to the client.
- Close reasons are `aborted | client-gone | max-heartbeats | max-idle |
  max-events | manual` and are logged with per-connection counters
  (`events_sent`, `heartbeats_sent`).

## Published lifecycle events (issue #1725)

Stream lifecycle routes publish to the in-process event bus **after** the store
write succeeds. Subscribers on `GET /api/streams/:id/events` and
`GET /api/streams/events` receive:

| event | when |
| --- | --- |
| `stream:updated:<id>` | the committed write changed `status`, `nextAction`, `pausedAt`, `settlementTxHash`, `withdrawal`, `cancellation`, `vestedAmount` or `releasedAmount` |
| `settle:finished:<id>` | after `stream:updated`, only when a settle moved the stream into `ended` |

The SSE payload is a redacted projection: `email`, `label`, `memo` and
`partnerId` are omitted, not masked. Each publish also emits an activity event
(`stream.pause`, `stream.settle`, …) for the activity timeline.

Producers are `start`, `pause`, `stop`, `settle`, `withdraw`, `cancel`,
`batch/start`, `batch/stop`, `v2/streams/batch`, the generic single-stream
update routes (v1 `POST`, v2 `PATCH`) and `admin/pause-by-sender`. Idempotent
replays, rejected transitions and writes that only touch PII or `updatedAt` do
**not** publish.

The bus is in-process. A subscriber connected to one API instance will not see
events committed on another instance; cross-process fan-out (Redis or Postgres
`LISTEN`) is deliberately out of scope for this change.

## Test coverage

- `app/lib/sse.test.ts` — unit tests for bounded heartbeats, max-events,
  rejected-write (client-gone), abort, idle deadline, and exactly-once close.
- `app/lib/stream-publish.test.ts` — lifecycle publication, redaction, event
  ordering, activity projection and no-op suppression.
- `app/api/streams/events/route.test.ts` — integration tests proving the
  stream emits exactly the configured number of heartbeats then closes, closes
  cleanly on client abort, delivers lifecycle frames, and returns the listener
  count to baseline after 200 connect/abort cycles.
