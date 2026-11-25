# Privacy & PII Handling

This document outlines StreamPay's PII retention policies, Data Subject Request (DSR) procedures, and data masking strategies.

## PII Inventory

The following fields are identified as PII and are subject to retention and deletion policies:

### Stream Records
- `email`: Recipient or contact email.
- `label`: User-defined name for the stream.
- `memo`: Transaction-specific notes.
- `partnerId`: External identifier for business partners.

### User Records
- `wallet_address`: Unique identifier for the user's wallet.
- `email`: User's registered email address.
- `display_name`: Human-readable name.

## Retention Policy

- **Legal/Audit Requirement**: Aggregate data (Stream ID, amounts, status, timestamps) must be retained for **7 years**.
- **PII Scrubbing**: All PII fields are permanently scrubbed from the database after a deletion request is processed.
- **Backups**: Backup rotation follows the primary database scrubbing (PII is aged out of backups according to our standard backup lifecycle).

### Retention Purge Job

`POST /api/internal/retention/purge` is an internal job that enforces the
seven-year window for streams that were never deleted by a data subject
request. It is signed with internal-service auth and only `ops-automation` may
call it.

- A stream is eligible when its `createdAt` is **strictly older** than seven
  years. A stream created exactly seven years ago is kept for one more run.
- For every eligible stream the job clears `email`, `label`, `memo` and
  `partnerId`. Stream ID, recipient, rate, status, amounts and timestamps are
  kept so accounting and audit history stay intact.
- Streams whose `createdAt` cannot be parsed are never purged; they are reported
  through `scanned` only.
- The body accepts `{ "dryRun": true }` to report what would be purged without
  mutating anything, and `{ "limit": 100 }` (1–500) to bound a run. The default
  limit is 100.
- Each purged stream appends one `retention.purge` audit event with actor
  `internal-service` and the caller's request id. Dry runs write no audit
  events.
- Re-running is idempotent: streams that no longer hold PII are counted as
  `alreadyScrubbed` and are not touched or re-audited.

Schedule the job at least daily, for example:

```bash
curl -X POST https://app.streampay.example/api/internal/retention/purge \
  -H "x-streampay-service-name: ops-automation" \
  # ...plus the signed internal-auth headers
  -d '{"limit":500}'
```

## DSR Fulfillment (Account Deletion)

### API Endpoint
`DELETE /api/v1/identity/me/delete`

### Process
1. **Request Received**: User triggers deletion via the API.
2. **Identification**: System identifies all streams and records associated with the user's `wallet_address` or `email`.
3. **Scrubbing**: PII fields are set to `undefined` or `null`. Original records remain for audit purposes but are "de-identified".
4. **Completion**: Deletion is guaranteed within **30 days** (202 Accepted returned initially).

## Data Masking & Redaction

- **Role-Based Access**:
  - `admin`: Full visibility of PII for support and debugging.
  - `user`: Masked PII (e.g., `e***l@example.com`) and redacted labels.
- **Exports**: All data exports redact PII by default unless explicitly requested with administrative privileges.

## Privacy Review Notes

- **Aggregates Only**: We do not store "orphaned" PII. Once the user record is deleted, the remaining stream data is strictly for accounting and cannot be re-linked to a natural person.
- **Idempotency**: Deletion requests are idempotent to prevent errors during repeated attempts.
- **No Substitute for On-Chain Privacy**: Note that on-chain transaction data (hashes, public keys) is immutable and outside the scope of this DSR fulfillment.
