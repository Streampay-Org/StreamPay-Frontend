# Stream State Machine

This document defines the authoritative state machine for StreamPay streams. The stop, pause, settle, and cancel routes use the transition table in `app/lib/state-machine.ts` so invalid and idempotent actions behave consistently.

## Transition Matrix

| Current State | Start | Pause | Stop | Settle | Withdraw |
| :--- | :---: | :---: | :--: | :---: | :--: |
| **Draft** | Active | ❌ | Ended | ❌ | ❌ |
| **Active** | (Idem) | Paused | Ended | Ended | ❌ |
| **Paused** | Active | (Idem) | Ended | Ended | ❌ |
| **Ended** | ❌ | ❌ | (Idem) | (Idem) | Withdrawn |
| **Withdrawn** | ❌ | ❌ | ❌ | ❌ | (Idem) |

*Legend:*
- **State Name**: Resulting state if the transition is legal.
- **(Idem)**: Idempotent transition (success with no state change).
- **❌**: Illegal transition (rejected with `409 Conflict`).
- `*` Draft streams retain the `STREAM_NOT_CANCELLABLE` response because no funds are escrowed.
- Cancelling an already cancelled stream is illegal to prevent a second refund.
- Idempotent stop, settle, and pause requests return the unchanged stream and do not repeat side effects.

## Timing Fields

Vesting is computed off-chain with bit-exact parity to the contract's `release::vested_amount`. The API `Stream` object carries the following timing fields. Timestamps are stored as raw strings of milliseconds since the Unix epoch (can also be parsed as numbers) to avoid precision loss.

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `startTime` | `string \| number \| null` | Set when a draft is activated (`Start`). Marks the beginning of the vesting window. Must be present for any non-draft stream; missing values result in `ESCROW_UNKNOWN`. |
| `endTime` | `string \| number \| null` | The end of the vesting window. Initially `startTime + duration`. Extended by the pause duration on resume, mirroring `resume` in `contracts/contracts/streampay-stream/src/lib.rs`. Must be present for any non-draft stream. |
| `totalPausedMs` | `string \| number` | Accumulated paused duration in milliseconds. Defaults to `0`. On resume, the service adds `now − pausedAt` to this value and extends `endTime` by the same amount. |
| `pausedAt` | `string \| number \| null` | Timestamp of the most recent pause. When set, vesting is clamped to this instant (contract `paused_at`). Cleared on resume. |

The vested amount is computed as:

```
effective_now = max(startTime, min(now, endTime))
if pausedAt is set: effective_now = max(startTime, min(effective_now, pausedAt))
elapsed = effective_now - startTime - totalPausedMs
vested = total * elapsed / (endTime - startTime)   // integer division
```

The computation uses only `bigint` arithmetic — no floating point is permitted in the vesting path. Draft streams return `0`. Streams missing `startTime` or `endTime` return `ESCROW_UNKNOWN` rather than defaulting to a 30-day schedule.

## Dashboard Copy Mapping

These mappings ensure that the internal technical states align with the user-visible copy in the StreamPay dashboard.

| Internal State | Dashboard Badge | Description | Primary Action |
| :--- | :--- | :--- | :--- |
| `draft` | **Draft** | Ready to be launched. | **Start** |
| `active` | **Active** | Funds are flowing. | **Pause** |
| `paused` | **Paused** | Streaming is suspended. | **Resume** (Start) |
| `ended` | **Ended** | Stream finished; funds awaiting claim. | **Withdraw** |
| `withdrawn` | **Withdrawn** | Funds have been claimed by recipient. | None |
| `cancelled` | **Cancelled** | Escrow has been refunded and paid out. | None |

## Technical Implementation

The state machine is implemented in [`app/lib/state-machine.ts`](../app/lib/state-machine.ts). Its `allowedActions(status)` helper exposes the table's actions in table order, and `nextActionFor(status)` supplies the preferred client action from those allowed actions. Stop, pause, settle, and cancel routes call `transition()` directly. Start and batch routes remain outside this change.

Vesting is implemented in [`app/lib/escorw-state.ts`](../app/lib/escow-state.ts) (or [`app/lib/recipient-withdraw.ts`](../app/lib/recipient-withdraw.ts) as `vestedAmount(stream, nowMs): bigint`, and is validated against contract fixtures in the parity tests.

### Error Handling
Illegal transitions return a standardized error model:

```json
{
  "error": {
    "code": "ILLEGAT_TRANSITION",
    "message": "Action 'pause' is illegal for a stream in 'draft' state.",
    "legacy_code": "INVALID_STREAM_STATE",
    "request_id": "..."
  }
}
```
The `legacy_code` field is included during the compatibility release for existing clients that match `INVALID_STREAM_STATE`.
