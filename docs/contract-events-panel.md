# Contract Events Panel

The contract events panel surfaces recent **lifecycle events** for a single
stream and lets users filter them by event type. It lives on a dedicated
stream-detail sub-page reachable from the stream's **Stream Operations** actions.

## Where it lives

| Path | Purpose |
|------|---------|
| `/streams/{id}/events` | Page route |
| `app/streams/[id]/events/page.tsx` | Server component — loads first page, validates stream |
| `app/streams/[id]/events/StreamEventsClient.tsx` | Client component — handles "Load more" |
| `app/components/EventTimeline.tsx` | Filterable, accessible timeline |
| `app/api/streams/[id]/history/route.ts` | `GET /api/streams/:id/history` — paginated endpoint |
| `app/lib/repositories/stream-history.ts` | Append-only per-stream event store |
| `app/lib/stream-history-writer.ts` | Write-path helper called by lifecycle routes |

## Architecture

```
Lifecycle route POST (pause, start, stop, settle, withdraw, cancel)
  └─ appendStreamHistoryEvent()       ← write-path helper
       └─ StreamHistoryStore.append() ← append-only in-memory store

GET /api/streams/:id/history?cursor=&limit=
  └─ StreamHistoryStore.query()       ← composite (at, id) cursor pagination
       └─ { data, meta: { nextCursor } }

/streams/{id}/events — server component
  └─ first page read from store
  └─ StreamEventsClient (client)
       └─ EventTimeline (filterable list + "Load more")
```

## Event store

### Entry shape

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | UUID, stable |
| `streamId` | `string` | Owning stream |
| `type` | `StreamHistoryEventType` | See table below |
| `fromStatus` | `string?` | Status before transition; absent for `created` |
| `toStatus` | `string` | Status after transition |
| `at` | `string` | ISO-8601 UTC timestamp |
| `actor` | `string?` | First 6 chars of actor wallet — **no PII** |
| `txHash` | `string?` | On-chain tx hash (once indexer wired) |
| `amountRaw` | `string?` | Human-readable amount (e.g. `"120 XLM"`) |

### Lifecycle events written

| Event | Written by | Transition |
|-------|-----------|-----------|
| `created` | `POST /api/streams` | → draft |
| `started` | `POST /api/streams/:id/start` (draft→active) | draft → active |
| `resumed` | `POST /api/streams/:id/start` (paused→active) | paused → active |
| `paused` | `POST /api/streams/:id/pause` | active → paused |
| `stopped` | `POST /api/streams/:id/stop` | active/draft → ended |
| `settled` | `POST /api/streams/:id/settle` | active/paused → ended |
| `withdrawn` | `POST /api/streams/:id/withdraw` | ended → withdrawn |
| `cancelled` | `POST /api/streams/:id/cancel` | active/paused → cancelled |

**Invariants:**
- Entries are **never mutated** (append-only).
- Idempotent replays intercepted by the idempotency layer produce **no entry**.
- Failed calls (route returns 4xx/5xx before calling the writer) produce **no entry**.
- No PII — no email, label, memo, or full wallet address.

## API endpoint: `GET /api/streams/:id/history`

**Headers required:** `x-tenant-id` (same visibility contract as `GET /api/streams/:id`)

**Query parameters:**

| Parameter | Default | Range |
|-----------|---------|-------|
| `limit` | 20 | 1–100 |
| `cursor` | — | From `meta.nextCursor` |

**Response (200):**
```json
{
  "data": [
    {
      "id": "3c4d5e6f-7a8b-9c0d-e1f2-a3b4c5d6e7f8",
      "streamId": "stream-abc12345",
      "type": "paused",
      "fromStatus": "active",
      "toStatus": "paused",
      "at": "2026-06-01T09:02:00.000Z",
      "actor": "GABCDE"
    }
  ],
  "meta": { "nextCursor": "<string | null>" }
}
```

| Status | Code | Reason |
|--------|------|--------|
| 400 | `MISSING_TENANT` | `x-tenant-id` absent or blank |
| 404 | `STREAM_NOT_FOUND` | Stream not in tenant |
| 422 | `VALIDATION_ERROR` | `limit` out of range |

## Frontend model

`StreamHistoryEntry` → `ContractEvent` mapping (in `page.tsx` / `StreamEventsClient.tsx`):

| `ContractEvent` field | Source |
|-----------------------|--------|
| `id` | `entry.id` |
| `type` | `entry.type` |
| `summary` | `buildSummary(entry)` — localized description |
| `timestamp` | `entry.at` |
| `txHash` | `entry.txHash` (optional) |
| `amount` | `entry.amountRaw` (optional) |

## Filtering

Single-select segmented control. Chips shown for **All** + each type present in data.
Active chip exposed via `aria-pressed`. Count changes announced via `role="status"` / `aria-live`.

## Accessibility (WCAG 2.1 AA)

- Filter controls are real `<button>`s in a labelled `role="group"`.
- The timeline uses semantic `<ul>` / `<li>` markup.
- After "Load more", focus moves to the first newly-loaded item (managed via `useEffect` + forwarded `ref`).
- "Load more" button uses `disabled` + `aria-busy` during loading.
- "No events yet" empty state is a `<p>` inside the accessible `<section>`.

## Future: on-chain indexer

`txHash` and `ledger` are optional in both the store entry and `ContractEvent`. Once
the Horizon indexer is wired, populate them in `appendStreamHistoryEvent()` and pass
`ledger` through to the `ContractEvent` shape.

See [horizon-indexer.md](horizon-indexer.md) and [live-events-protocol.md](live-events-protocol.md).

> **Note:** `GET /api/streams/{id}/events` is a **Server-Sent Events** endpoint for live
> deltas — it is unrelated to this read-only history endpoint at `/api/streams/{id}/history`.
