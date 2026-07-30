# Runbook: Stream Reconciliation Mismatch

This document outlines the steps to take when the nightly reconciliation job detects a mismatch between the StreamPay database and the on-chain (Stellar/Soroban) state.

## Health probe

Use `GET /api/reconciliation/health` to verify that the reconciliation dependencies needed by the service are available. The endpoint returns `200 OK` when both the database and on-chain dependencies are ready and `503 Service Unavailable` when either dependency reports degraded readiness. The payload includes per-dependency status and timestamps for easier monitoring and alerting.

## Per-stream diff endpoint

`GET /api/internal/reconciliation/diff/:id` lets you inspect the DB-vs-on-chain diff for a single stream without triggering a full reconciliation run. Use it to quickly triage alerts from the nightly job.

**Auth**: HMAC-signed service-to-service headers (same scheme as `POST /api/internal/reconciliation`). Auth failures return `404` to conceal the route. See [docs/internal-service-auth.md](internal-service-auth.md) for the signing guide.

**Example request (using `curl` with pre-signed headers):**
```bash
# Assuming $HMAC_HEADERS is a bash associative array of the required headers
curl -s -X GET \
  -H "x-streampay-service-name: ops-automation" \
  -H "x-streampay-key-id: $KEY_ID" \
  -H "x-streampay-timestamp: $TS_MS" \
  -H "x-streampay-content-sha256: $BODY_SHA256" \
  -H "x-streampay-signature: v1=$SIG" \
  "https://api.streampay.example/api/internal/reconciliation/diff/stream_2"
```

**200 response shape:**
```json
{
  "data": {
    "streamId": "stream_2",
    "checkedAt": "2026-07-23T22:00:00.000Z",
    "inSync": false,
    "diffs": [
      {
        "field": "released_amount",
        "dbValue": "1000000000",
        "onChainValue": "1100000000",
        "toleranceApplied": false
      }
    ],
    "db": { "id": "stream_2", "recipient_address": "G…", "total_amount": "5000000000", "released_amount": "1000000000", "status": "ACTIVE", "last_sync_ledger": 0 },
    "onChain": { "id": "stream_2", "recipient_address": "G…", "total_amount": "5000000000", "released_amount": "1100000000", "status": "active" }
  },
  "meta": { "auth": { "keyId": "current", "timestamp": "2026-07-23T22:00:00.000Z" } }
}
```

| Field | Description |
|-------|-------------|
| `inSync` | `true` when DB and on-chain agree within tolerance |
| `diffs` | Array of per-field mismatches; empty when `inSync: true` |
| `db` | Snapshot of the DB record at time of check |
| `onChain` | Snapshot of the on-chain record; `null` if absent on-chain |

**404 responses** are returned for unknown stream IDs **and** for any auth failure (route concealment). If you receive an unexpected 404 for a valid stream, verify your HMAC headers first.

## 1. Identify the Mismatch
Check the reconciliation report (logs or Slack alert). Each mismatch includes:
- **Stream ID**: The unique identifier of the stream.
- **Field**: The field that mismatched (e.g., `released_amount`, `total_amount`, `status`).
- **DB Value**: The value currently stored in our database.
- **On-Chain Value**: The value fetched directly from the Stellar/Soroban contract.

## 2. Verify On-Chain Truth
Before taking action, manually verify the stream state using a block explorer or the Stellar CLI.
- **Soroban**: Use `stellar contract read` or a Soroban explorer.
- **Classic Stellar**: Use [StellarExpert](https://stellar.expert).

## 3. Common Causes
- **Index Lag**: The indexer might be a few ledgers behind the current chain tip.
- **Rounding**: Small differences due to bigint/decimal conversion (check if within tolerance).
- **Failed Transactions**: A transaction might have been recorded in the DB but failed on-chain (or vice versa).
- **Double Credits**: Potential bug in the settlement logic.

## 4. Remediation Steps
### A. If DB is behind (Index Lag)
1. Trigger a manual backfill for the affected stream using the `backfill-indexer.ts` script.
2. Wait 5 minutes and run the on-demand reconciliation CLI to check if it's resolved:
   ```bash
   npm run recon:cli -- --stream-id <streamId>
   ```

### B. If DB is ahead (Double Credit/Phantom Sync)
1. **Freeze the Stream**: If the UI allows it, pause the stream to prevent further withdrawals.
2. **Investigate Logs**: Search for the `correlation_id` of the last settlement transaction for that stream.
3. **Manual Fix**: If the mismatch is confirmed and intentional (e.g., manual adjustment needed), update the DB record to match the on-chain truth.
4. **Verify**: Run the on-demand reconciliation CLI to ensure the mismatch is resolved:
   ```bash
   npm run recon:cli -- --stream-id <streamId>
   ```

### C. If On-Chain is inconsistent
1. This indicates a potential smart contract bug or a deep chain reorganization (rare on Stellar).
2. Escalated to the Blockchain Engineering team immediately.

### D. On-Demand CLI Tool Reference
You can run ad-hoc reconciliation for a single stream at any time using:
```bash
npm run recon:cli -- --stream-id <streamId> [--tolerance <n>] [--dry-run]
```
- `--tolerance <n>` allows overriding the mismatch tolerance for balance drift rounding.
- `--dry-run` performs the check and outputs the JSON report/mismatches without updating the stream's status in the database.
- The command exits with `0` on success, or `1` if a mismatch or error is found. Output logs are JSON-formatted with a correlation `request_id`.

## 5. Prevention
- Review recent changes to `lib/indexer.ts` or the smart contract logic.
- Ensure `Idempotency-Key` is being used correctly for all mutating requests.
