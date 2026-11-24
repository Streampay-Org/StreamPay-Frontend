# Approvals API (multi-sig)

When an org sets `policy.requireApprovals` to `2`, the `settle` and `stop`
actions on its streams need a second signer. These routes let a member start an
approval and let a second member vote on it.

Response bodies and status codes below were captured by calling the real route
handlers. Threshold logic lives in `app/lib/org-policy.ts`
(`checkStreamOrgPolicy`, `initiateApproval`, `castApproval`), state in
`app/lib/org-db.ts`, and types in `app/lib/org-types.ts`.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/streams/{id}/approvals` | List the stream's pending approvals. |
| `POST` | `/api/streams/{id}/approvals` | Start an approval for `settle` or `stop`. |
| `POST` | `/api/streams/{id}/approvals/{approvalId}/approve` | Cast a vote on an approval. |

`POST` routes need the `Actor-Wallet-Address` header. `GET` is unauthenticated.
These routes read the raw header only; they do not use the JWT resolution or the
`STREAMPAY_ALLOW_ACTOR_HEADER` flag that the stream lifecycle routes use.

## Threshold semantics

- `requireApprovals` is `1` or `2` (`StreamPolicy` allows nothing else).
- With `1`, `settle` and `stop` run immediately and no approval record exists:
  `POST /approvals` answers `400 APPROVAL_NOT_REQUIRED`.
- With `2`, calling the stream's `settle` or `stop` route directly is rejected
  with `409 APPROVAL_REQUIRED` until an approval is started here.
- Only `settle` and `stop` are two-step actions (`TWO_STEP_ACTIONS`).
- **The initiator's vote counts.** `initiateApproval` creates the record with
  `approvals: [initiatedBy]` and `requiredCount` set to `requireApprovals`. With
  `requireApprovals: 2`, one **more** distinct eligible member must vote.
- `castApproval` appends the voter and sets `thresholdMet` when
  `approvals.length >= requiredCount`. At that point `status` becomes
  `approved`.
- Both the initiator and every voter must hold a role the org's policy allows
  for the action (`canSettle` or `canStop`). With the default policy, `settle`
  is `owner` or `settler` and `stop` is `owner` only, so a `stop` approval needs
  two owners.
- A wallet can vote once per approval, and only one `pending` approval can exist
  per stream and action at a time.

> **MVP limitation.** Reaching the threshold returns `meta.thresholdMet: true`
> and marks the approval `approved`, but the approve route does **not** execute
> the settle or stop. The route contains a placeholder comment ("In a real
> implementation, we would call the business logic reducer here"). Callers must
> perform the action themselves after seeing `thresholdMet`.

## Approval lifecycle

`ApprovalStatus` is `pending`, `approved`, `rejected` or `expired`.

| Status | Meaning |
| --- | --- |
| `pending` | Created by `POST /approvals`; waiting for more votes. |
| `approved` | The vote that reached `requiredCount` set this. Terminal. |
| `rejected` | Defined in the type, but no route or function sets it today. |
| `expired` | `expiresAt` passed before the threshold was met. Terminal. |

Expiry is **lazy**: an approval lives for 24 hours (`APPROVAL_TTL_MS`) and no
background job flips it. The status changes the next time someone touches it:

- `getActiveApprovalsForStream` (behind `GET /approvals`) marks any past-due
  approval `expired` and leaves it out of the list. It also omits `approved` and
  `rejected` records, so the list only ever contains `pending` approvals.
- `castApproval` checks `expiresAt` before accepting a vote, marks the record
  `expired`, and returns `409`.

Because expiry is lazy, a past-due approval still counts as `pending` until one
of the two paths above touches it. `initiateApproval` only checks
`status === "pending"` and ignores `expiresAt`, so until then starting a new
approval for the same stream and action returns `409 INITIATION_FAILED`. A
`GET /approvals` call is enough to flip the stale record to `expired` and
unblock the retry.

## `GET /api/streams/{id}/approvals`

```bash
curl http://localhost:3000/api/streams/stream-ada/approvals
```

```json
{
  "data": [
    {
      "id": "appr-4fbf64a9",
      "streamId": "stream-ada",
      "orgId": "org-acme",
      "action": "settle",
      "initiatedBy": "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW",
      "approvals": ["GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW"],
      "requiredCount": 2,
      "status": "pending",
      "createdAt": "2026-11-24T02:21:10.370Z",
      "expiresAt": "2026-11-25T02:21:10.370Z"
    }
  ],
  "meta": { "total": 1 },
  "links": { "self": "/api/streams/stream-ada/approvals" }
}
```

This route always returns `200`, with `data: []` when nothing is pending.

## `POST /api/streams/{id}/approvals`

Body: `{ "action": "settle" | "stop" }`. Checks run in this order: header, JSON
body, `action`, org ownership, role, whether approval is required, then
creation.

```bash
curl -X POST http://localhost:3000/api/streams/stream-ada/approvals \
  -H "Content-Type: application/json" \
  -H "Actor-Wallet-Address: GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW" \
  -d '{"action":"settle"}'
```

`201 Created`:

```json
{
  "data": {
    "id": "appr-4fbf64a9",
    "streamId": "stream-ada",
    "orgId": "org-acme",
    "action": "settle",
    "initiatedBy": "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW",
    "approvals": ["GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW"],
    "requiredCount": 2,
    "status": "pending",
    "createdAt": "2026-11-24T02:21:10.370Z",
    "expiresAt": "2026-11-25T02:21:10.370Z"
  }
}
```

## `POST /api/streams/{id}/approvals/{approvalId}/approve`

No body. The voter is the `Actor-Wallet-Address`.

```bash
curl -X POST http://localhost:3000/api/streams/stream-ada/approvals/appr-4fbf64a9/approve \
  -H "Actor-Wallet-Address: GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS"
```

`200 OK`, threshold reached:

```json
{
  "data": {
    "id": "appr-4fbf64a9",
    "streamId": "stream-ada",
    "orgId": "org-acme",
    "action": "settle",
    "initiatedBy": "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW",
    "approvals": [
      "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW",
      "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS"
    ],
    "requiredCount": 2,
    "status": "approved",
    "createdAt": "2026-11-24T02:21:10.370Z",
    "expiresAt": "2026-11-25T02:21:10.370Z"
  },
  "meta": { "thresholdMet": true }
}
```

`meta.thresholdMet` is `false` and `status` stays `pending` when more votes are
still needed.

## Errors

All errors use the envelope below. These routes always set `request_id` to the
literal `mock-request-id`.

```json
{
  "error": {
    "code": "ROLE_INSUFFICIENT",
    "message": "Role 'viewer' is not permitted to perform 'settle'.",
    "request_id": "mock-request-id"
  }
}
```

### `POST /approvals`

| Status | Code | Trigger |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | `Actor-Wallet-Address` header missing. |
| 400 | `INVALID_REQUEST` | Body is not valid JSON. |
| 422 | `VALIDATION_ERROR` | `action` missing or not `settle` / `stop`. |
| 400 | `STREAM_NOT_ORG_OWNED` | The stream has no owning org (or its org record is gone), so approvals do not apply. |
| 403 | `NOT_ORG_MEMBER` | The caller is not a member of the stream's org. |
| 403 | `ROLE_INSUFFICIENT` | The caller's role is not allowed to perform `action` by the org policy. |
| 400 | `APPROVAL_NOT_REQUIRED` | The org's `requireApprovals` is `1`. |
| 409 | `INITIATION_FAILED` | A `pending` approval for the same stream and action already exists; the message includes its id. |

### `POST /approvals/{approvalId}/approve`

| Status | Code | Trigger |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | `Actor-Wallet-Address` header missing. |
| 404 | `APPROVAL_NOT_FOUND` | No such approval, or it belongs to a different stream. |
| 404 | `ORG_NOT_FOUND` | The approval's org no longer exists. |
| 409 | `VOTE_FAILED` | The approval is no longer `pending` (the message names the status), has expired, or the caller already voted (the initiator has, automatically). |
| 403 | `VOTE_FAILED` | The voter is not an org member, or their role may not perform the approval's action. |

`VOTE_FAILED` carries the underlying reason in `message` and its status comes
from `castApproval`, so branch on the HTTP status and message, not only the
code.

### Related code on other routes

`NOT_ORG_MEMBER`, `ROLE_INSUFFICIENT` and `APPROVAL_REQUIRED` also come from
`enforceStreamRbac` on the stream lifecycle routes, where
`APPROVAL_REQUIRED` is a `409` telling the caller to start an approval first.
`CROSS_ORG_DENIED` exists in the `PolicyDenied` type but no code path emits it.
