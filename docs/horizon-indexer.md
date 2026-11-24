# Horizon Events Indexer

The Horizon Events Indexer (`lib/indexer.ts`) tracks on-chain Stellar events to drive stream settlement and escrow states. It persists cursors, supports safe backfills, and deduplicates events idempotently to handle network gaps or reorgs without silent data loss.

## How to Re-index

If you need to re-index from a specific ledger or re-sync the entire network due to a database wipe or deployment of a new schema:

1. **Pause the Main Loop:** Stop the active indexer process to prevent race conditions during backfill.
2. **Update Cursor State:** If you want to force a full re-index, clear the network's `last_ledger` cursor from the database. Alternatively, set it to your desired starting ledger.
3. **Run Backfill:** Execute the backfill job. The indexer will use a safe `overlapWindow` to scan backward from the current cursor, preventing missed events during the deployment or restart window.
   ```typescript
   // Example usage in a script
   const indexer = new HorizonIndexer(config);
   await indexer.backfill(targetLedger, fetchEventsForBackfill);
   ```
4. **Resume Indexer:** Restart the main event stream loop. Because of idempotency using natural keys (`network:event_id:event_type`), duplicate events re-processed during the overlap will be safely ignored.

## Time to Backfill

Backfill speeds depend heavily on your RPC/Horizon provider's rate limits and latency.
- **Paging Limits:** Horizon typically returns up to 200 records per page.
- **Estimated Throughput:** An average backfill job processing pure ledger transitions without heavy database mutations can process roughly 50,000 to 100,000 events per minute.
- **Re-indexing an entire month** (~500,000 ledgers) could take anywhere from 10 to 30 minutes, depending on the volume of matching events (`payment`, `invoke_host_function`, etc.).

## Disk Expectations

The indexer strictly persists cursors and deduplication keys.
- **Cursor State:** Negligible. A single row/record per network containing `last_ledger` and `last_updated_at`.
- **Deduplication Set:** Storing processed event keys (`testnet:evt_123:payment`) requires some space. 
  - Assuming string keys are ~50 bytes each, 1,000,000 events will consume ~50MB of memory or disk space.
  - *Recommendation:* In a production durable store (like Redis or PostgreSQL), configure a TTL (Time-To-Live) for idempotency keys (e.g., 7-14 days) to prevent unbounded disk growth while maintaining safe overlap guarantees for typical deployment windows.

## Alerting and Diagnostics

The indexer implements structured logging and stall checks:
- **Stall Alerts:** Emits an alert if the cursor is not updated within the defined `stallThresholdMs` (e.g., 5-10 minutes), helping catch silent failures or RPC unreachability.
- **Structured Error Logs:** Errors are logged with a JSON payload including a `correlation_id` and `stream_id` to trace transaction states efficiently.

## Status State Machine (deterministic stale-state transitions)

The indexer status is derived through a **pure, deterministic state machine**
(`lib/indexerStatus.ts`), never from randomness. Given the same telemetry it
always produces the same status, so normal operation and adverse conditions are
reviewable and cannot silently mask a degraded indexer.

States: `loading`, `syncing`, `synced`, `stalled`, `stopped`, `error`, `retrying`.

Transition priority (highest wins):
1. `breakerOpen` → `stopped` (permission / operator circuit breaker)
2. `!running` → `stopped`
3. fatal failure → `error`
4. recoverable failure → `retrying`
5. cursor age exceeds `stallThresholdMs` → `stalled` (the explicit stale-state transition)
6. cursor never advanced → `loading`
7. lag ≤ tolerance → `synced`, else `syncing`

Key invariants:
- `deriveIndexerStatus` and `isStale` are pure — all time comes from the caller,
  making transitions reproducible in tests.
- A stale cursor (`isStale(...) === true`) **must** report `stalled` and can never
  silently report `synced`/`syncing`.
- `isStale` uses a strictly-greater-than comparison, so `age === threshold` is
  still fresh; a non-positive threshold disables staleness detection.
- Failure disposition (`error`/`retrying`) is cleared on the next successful
  cursor advance, so the status recovers deterministically.

Surfacing:
- `GET /api/indexer/status` returns the derived `status` plus an explicit `stale`
  flag and a human-readable `message` (safe to surface to operators — never leaks
  secrets or raw request data).
- `HorizonIndexer.readStatus()` exposes the same derivation for the ingestion
  worker, so monitoring and the SSE endpoint agree on the current state.

