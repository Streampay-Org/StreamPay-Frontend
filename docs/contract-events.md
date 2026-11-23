# Contract events panel

The stream events route at `/streams/[id]/events` presents a filterable, accessible timeline of contract lifecycle events.

## Current data contract

The page currently uses local placeholder event data for the existing sample streams. Each event follows the `ContractEvent` shape exported by `app/components/EventTimeline.tsx`:

- `id`: stable event identifier
- `type`: lifecycle event type
- `summary`: human-readable description
- `timestamp`: ISO-8601 UTC timestamp
- `txHash`: transaction hash
- `ledger`: ledger sequence number
- `amount`: optional human-readable amount

When an indexer-backed endpoint is available, replace the page-level mock source with the API response while preserving this shape. The visible UI exposes event-type filters, event count announcements, transaction identifiers, and ledger numbers.
