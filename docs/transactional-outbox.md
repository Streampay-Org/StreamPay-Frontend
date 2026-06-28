# Transactional Outbox for Stream Domain Events

## Problem

`app/lib/event-bus.ts` historically published domain events **inline** via a
fire-and-forget `EventEmitter.emit`. State was mutated, then the event was
emitted as a separate, non-durable step. If the process crashed between (or
during) those two operations, the event was **silently lost** — SSE
subscribers, webhooks, and downstream consumers never learned the stream had
changed.

## Solution

A **transactional outbox**. Producers append the event to a durable `outbox`
table in the *same step* as the state change. A background worker then drains
the table and performs the actual publish.

```
applyAction()                          StreamEventOutboxWorker.drainOnce()
┌───────────────────────────┐          ┌────────────────────────────────┐
│ 1. mutate stream state     │         │ 1. claimBatch()  (FIFO, by seq)  │
│ 2. outbox.enqueue(event)   │  ──────▶ │ 2. eventBus.publishFromOutbox()  │
│    (same transaction)      │  outbox  │ 3. markPublished() / markFailed()│
└───────────────────────────┘          └────────────────────────────────┘
```

Because the state write and the outbox write happen together (in this in-memory
mock, two synchronous `Map` writes; in production, one Postgres transaction),
they either both happen or neither does. The event can never be lost relative to
the state change that produced it.

## Delivery guarantees

- **At-least-once.** An entry is only removed from the claimable set once it is
  explicitly marked `published`. A crash before that leaves the entry to be
  re-claimed and redelivered.
- **No loss on crash.** A worker that dies mid-publish leaves its entry in
  `processing`. After a **visibility timeout** the entry is considered abandoned
  and becomes claimable again (crash recovery).
- **FIFO.** Entries carry a monotonic `seq` and are claimed in order.
- **Idempotent enqueue.** Supplying a deterministic `id` (e.g.
  `stream.updated:<streamId>:<updatedAt>`) makes a retried producer a no-op
  rather than a duplicate row.

> **Consumers must be idempotent.** At-least-once means duplicates are possible
> (e.g. a publish that succeeded but crashed before `markPublished`). Dedupe on
> `entry.id`.

## Status lifecycle

```
                       ┌──────────────► published   (terminal success)
 enqueue → pending ──► processing ─────┤
   ▲                       │           └──────────────► failed ──┐
   │  (visibility timeout) │                                     │ (retry, backoff)
   └───────────────────────┘                                     ▼
                            attempts ≥ maxAttempts ──────────► dead  (DLQ)
```

| Status       | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `pending`    | Written, waiting to be claimed/redelivered.                |
| `processing` | Claimed by a worker; publish in flight.                    |
| `published`  | Successfully emitted (terminal success).                   |
| `failed`     | A publish attempt failed; backoff retry scheduled.         |
| `dead`       | Exhausted all attempts; parked in the DLQ for inspection.  |

Retries use exponential backoff (`BASE_BACKOFF_MS · 2^(attempts-1)`, capped at
`MAX_BACKOFF_MS`). After `maxAttempts` the entry moves to the DLQ (`dead`),
inspectable via `outbox.getDeadLetters()`.

## API

### Producing (in the same transaction as the state change)

```ts
import { eventBus } from "@/app/lib/event-bus";

eventBus.enqueueStreamUpdated(streamId, stream, {
  id: `stream.updated:${streamId}:${stream.updatedAt}`, // idempotent enqueue
});
eventBus.enqueueSettleFinished(streamId, stream, {
  id: `settle.finished:${streamId}:${stream.updatedAt}`,
});
```

`app/lib/stream-service.ts` does exactly this. The legacy inline
`emitStreamUpdated` / `emitSettleFinished` calls are retained for low-latency
live (SSE) delivery; the outbox is the durable safety net.

### Draining

```ts
import { streamEventOutboxWorker } from "@/app/lib/worker";

// Drain a single batch (e.g. from a scheduler tick):
const { published, retried, dead } = await streamEventOutboxWorker.drainOnce();

// Or drain until the queue is empty:
await streamEventOutboxWorker.drainAll();
```

The worker replays each entry to live subscribers via
`eventBus.publishFromOutbox(entry)`. Inject a custom `publish` function or a
dedicated `StreamEventOutbox` instance via the constructor for tests or
alternative sinks.

## Files

| File                                     | Role                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `app/lib/stream-event-outbox.ts`         | The outbox table/store, status enum, claim/ack. |
| `app/lib/event-bus.ts`                   | `enqueue*` producers + `publishFromOutbox`.     |
| `app/lib/worker.ts`                      | `StreamEventOutboxWorker` (FIFO drainer).       |
| `app/lib/stream-service.ts`              | Producer wired into the state transition.       |
| `app/lib/stream-event-outbox*.test.ts`   | Store + worker tests.                           |
| `app/lib/event-bus.test.ts`              | Transactional producer/replay tests.            |

## Production notes

This mock keeps the outbox in memory. In production the table is Postgres:

```sql
CREATE TYPE outbox_status AS ENUM
  ('pending', 'processing', 'published', 'failed', 'dead');

CREATE TABLE stream_event_outbox (
  id              text PRIMARY KEY,
  seq             bigserial NOT NULL,        -- FIFO ordering
  event_type      text NOT NULL,
  stream_id       text NOT NULL,
  payload         jsonb NOT NULL,
  status          outbox_status NOT NULL DEFAULT 'pending',
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 5,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  correlation_id  text,
  last_error      text
);

-- Claim worker reads the oldest claimable rows; SELECT ... FOR UPDATE SKIP
-- LOCKED gives the same crash-safe, contention-free claiming as the in-memory
-- visibility timeout used here.
CREATE INDEX ON stream_event_outbox (status, next_attempt_at, seq);
```

The enqueue runs inside the same DB transaction as the stream state change; the
worker claims with `FOR UPDATE SKIP LOCKED`, ordered by `seq`.
