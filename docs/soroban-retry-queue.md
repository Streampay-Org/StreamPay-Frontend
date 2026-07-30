# Soroban Retry Queue

> Added as part of [#913](https://github.com/Streampay-Org/StreamPay-Frontend/issues/913)

## Overview

The Soroban retry queue provides a persistent, bounded retry mechanism for Soroban RPC operations (simulate, submit, fetch) that fail transiently. It sits alongside the existing `onChainClient.ts` and can be wired in by any caller that catches a `SorobanError`.

## Lifecycle

```
enqueue() ──► PENDING ──► dequeue() ──► PROCESSING
                 ▲                          │
                 │               markFailed() + backoff
                 │                          │
                 │      retries < max?      │  retries >= max?
                 └──────────────────────────┼──────────────► DEAD LETTER
                                            │
                                 markComplete() ──► COMPLETED (removed)
```

1. **Enqueue**: A failed operation is added to the queue with its payload and a correlation ID.
2. **Dequeue**: The oldest eligible `PENDING` entry is atomically transitioned to `PROCESSING`.
3. **markFailed**: On retry failure, the entry is either re-scheduled with exponential backoff or moved to the dead-letter queue if retries are exhausted.
4. **markComplete**: A successfully retried entry is removed from the queue.
5. **Dead Letter**: Entries that exhaust all retries are preserved for manual intervention via `requeueDeadLetter()`.

## Retry Behaviour

- **Exponential backoff**: `baseDelayMs × 2^attempt`, capped at `maxDelayMs`.
- **Jitter**: ±`jitterFactor`% random jitter applied to each delay to avoid thundering-herd.
- **Bounded**: After `maxRetries` (default 3), the entry is permanently moved to the dead-letter queue.
- **Deterministic**: With a fixed random source, backoff delays are fully reproducible.

## Persistence Strategy

Currently uses an in-memory `Map` for storage, matching the project's pattern for `cursorsDb`, `processedEventsDb`, and other in-memory stores. The storage interface (`StorageAdapter`) is intentionally narrow — only `get`, `set`, `delete`, `entries`, and `clear` — so migrating to PostgreSQL or Redis requires swapping only the adapter implementation.

## Public API

| Method | Signature | Description |
|---|---|---|
| `enqueue` | `(operation, payload, correlationId?) → RetryQueueResult<{id}>` | Add a retryable operation. |
| `dequeue` | `(now?) → RetryQueueResult<RetryQueueEntry \| null>` | Retrieve the next ready entry (FIFO). |
| `markComplete` | `(id) → RetryQueueResult` | Remove a successfully retried entry. |
| `markFailed` | `(id, error, now?) → RetryQueueResult<{status, nextRetryAt?}>` | Record a failed attempt; schedule retry or dead-letter. |
| `getQueueDepth` | `() → number` | Number of entries in `PENDING` status. |
| `getDeadLetterEntries` | `() → RetryQueueEntry[]` | All entries that exhausted retries. |
| `requeueDeadLetter` | `(id) → RetryQueueResult` | Move a dead-letter entry back to `PENDING`. |
| `getEntry` | `(id) → RetryQueueResult<RetryQueueEntry \| null>` | Inspect a single entry (defensive copy). |
| `setConfig` | `(partial) → RetryQueueResult` | Override queue configuration. |
| `getConfig` | `() → SorobanRetryQueueConfig` | Current configuration (defensive copy). |
| `clear` | `() → void` | Reset all state (test helper). |

### Error Envelope

Every method returns `RetryQueueResult<T>`:

```ts
interface RetryQueueResult<T = void> {
  ok: boolean;
  error?: RetryQueueError;  // present only when ok === false
  data?: T;                 // present only when ok === true
}

interface RetryQueueError {
  code: string;             // e.g. "INVALID_PAYLOAD"
  message: string;          // human-readable, API-safe
  correlationId: string;    // for end-to-end tracing
  details?: Record<string, unknown>;
}
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `maxRetries` | 3 | Maximum attempts before dead-letter. |
| `baseDelayMs` | 1000 | Starting backoff delay in milliseconds. |
| `maxDelayMs` | 30000 | Cap on exponential backoff. |
| `jitterFactor` | 0.1 | ±10% random jitter on each delay. |

Configure via `sorobanRetryQueue.setConfig({ ... })`.

## Usage Example

```ts
import { sorobanRetryQueue } from "@/lib/sorobanRetryQueue";
import { onChainClient } from "@/lib/onChainClient";
import { SorobanError } from "@/types";

async function retryOperation(streamId: string) {
  // Try the operation first
  try {
    return await onChainClient.fetchStream(streamId);
  } catch (err) {
    if (err instanceof SorobanError) {
      // Enqueue for later retry
      const result = sorobanRetryQueue.enqueue("fetchStream", { streamId });
      if (!result.ok) {
        console.error("Failed to enqueue retry:", result.error);
        throw err;
      }
    } else {
      throw err;
    }
  }
}

// Background processor
async function processRetries() {
  const entry = sorobanRetryQueue.dequeue();
  if (!entry.data) return;

  try {
    await onChainClient.fetchStream(entry.data.payload.streamId);
    sorobanRetryQueue.markComplete(entry.data.id);
  } catch (err) {
    sorobanRetryQueue.markFailed(entry.data.id, err);
  }
}
```

## Security Notes

- **Boundary validation**: All public methods validate inputs before processing — invalid operations, malformed payloads, and non-SorobanError failures are rejected with `RetryQueueError`.
- **Standardised error handling**: Every error carries a machine-readable `code`, a human-readable `message`, and a `correlationId`.
- **No secrets in logs**: Only stable `SorobanErrorCode` variants are logged; raw error messages and payloads (which may contain addresses) are excluded from error-level logs.
- **Correlation IDs preserved**: Every entry carries a UUID correlation ID from creation through exhaustion.
- **Bounded retries**: `maxRetries` is strictly enforced — no infinite retry loops.
- **Deterministic**: Backoff is computed from a pure function with an injectable random source for test reproducibility.

## Files

| File | Purpose |
|---|---|
| `lib/sorobanRetryQueue.ts` | Implementation |
| `lib/sorobanRetryQueue.test.ts` | Tests |
| `docs/soroban-retry-queue.md` | This documentation |
