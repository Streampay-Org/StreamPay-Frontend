# Contract Events Panel

The contract events panel surfaces recent **on-chain contract events** for a
single stream and lets users filter them by event type. It lives on a dedicated
stream-detail sub-page and is linked from the stream's **Stream Operations**
actions.

## Where it lives

| Path | Purpose |
|------|---------|
| `/streams/{id}/events` | Page route — contract events panel for a stream |
| `app/streams/[id]/events/page.tsx` | Server component; resolves the stream and supplies event data |
| `app/components/EventTimeline.tsx` | Client component; renders the filterable timeline |

The panel is reachable from the **View Contract Events** action on
`/streams/{id}` (the stream detail page).

## On-chain event scheme

All stream-level events are emitted by the `streampay-stream` Soroban contract
using a two-topic layout:

```
topic[0] = Symbol("stream")
topic[1] = Symbol("<event_name>")   e.g. "created", "started", …
data     = vec-encoded struct fields (see table below)
```

The `upgrade` event uses `("StreamPay", "upgraded")` as its topic pair.

### Lifecycle event reference

| Event name | Emitted by | Payload fields (in order) |
|------------|-----------|--------------------------|
| `created`  | `create_stream` | `stream_id`, `sender`, `recipient`, `token`, `total_amount`, `timestamp` |
| `started`  | `start_stream`  | `stream_id`, `start_time`, `end_time`, `timestamp` |
| `paused`   | `pause`         | `stream_id`, `sender`, `pause_time`, `timestamp` |
| `resumed`  | `resume`        | `stream_id`, `sender`, `end_time`, `timestamp` |
| `withdrawn`| `withdraw`      | `stream_id`, `recipient`, `amount`, `timestamp` |
| `settled`  | `withdraw` (full drain) or `settle` | `stream_id`, `recipient`, `total_amount`, `timestamp` |
| `cancelled`| `cancel_stream` | `stream_id`, `cancelled_by`, `returned_amount`, `released_amount`, `timestamp` |
| `amended`  | `amend_stream`  | `stream_id`, `amended_by`, `new_rate_per_second`, `new_end_time`, `timestamp` |
| `upgraded` | `upgrade`       | `new_wasm_hash` (single value, topics `"StreamPay"/"upgraded"`) |

**Invariants:**
- Events are emitted **after** the successful state mutation and any token transfer.
- Failed calls (returning `Err`) emit **no events**.
- When a full `withdraw` settles a stream, **two** events are emitted in sequence: `withdrawn` then `settled`.
- `settle` emits only `settled` (one event).

### Admin utility events

| Event name | Emitted by | Topics | Payload |
|------------|-----------|--------|---------|
| `set_pause` | `set_paused` | `("stream", "set_pause")` | `(admin, paused, timestamp)` |
| `set_admin` | `set_admin`  | `("stream", "set_admin")` | `(old_admin, new_admin, timestamp)` |
| `set_token` | `set_token_allowed` | `("stream", "set_token")` | `(admin, token, allowed, timestamp)` |

## Frontend event model

Each event uses the `ContractEvent` shape exported from
`app/components/EventTimeline.tsx`:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Stable key |
| `type` | `ContractEventType` | `created`, `started`, `paused`, `resumed`, `withdrawn`, `settled`, `cancelled`, `amended` |
| `summary` | `string` | Human-readable description |
| `timestamp` | `string` | ISO-8601 UTC; rendered relative via `Timestamp` |
| `txHash` | `string` | Soroban transaction hash (copy + truncate via `CopyAddress`) |
| `ledger` | `number` | Ledger sequence number |
| `amount` | `string?` | Optional value label for fund-moving events (e.g. `"120 XLM"`) |

Events are sorted newest-first inside the component, so callers may pass them in
any order.

## Filtering

The filter toolbar is a single-select segmented control. A chip is rendered for
**All** plus each event type that actually appears in the data, each showing a
count. The active chip is exposed via `aria-pressed`, and the visible-event
count is announced through a `role="status"` live region for screen readers.

## Accessibility & theming

- Filter controls are real `<button>`s inside a labelled `group`, fully
  keyboard operable with visible focus rings.
- Result-count changes are announced politely via `aria-live`.
- The timeline reuses the shared `.activity-*` styles and design tokens, so it
  is responsive across breakpoints and consistent in light and dark mode.

## API status

This is a **UI-only** feature. No API routes were added or changed. The page
currently renders mocked events that mirror the placeholder streams used across
the app (see `app/streams/[id]/page.tsx`). To wire real data, replace
`MOCK_EVENTS` in the page with a fetch against the chain indexer (see
[horizon-indexer.md](horizon-indexer.md) and
[live-events-protocol.md](live-events-protocol.md)) and map the result to
`ContractEvent[]`.

> Note: `GET /api/streams/{id}/events` already exists and is a **Server-Sent
> Events** stream for live deltas — it is unrelated to this read-only panel.
> A future durable list endpoint should use a distinct path such as
> `/api/streams/{id}/contract-events`.
