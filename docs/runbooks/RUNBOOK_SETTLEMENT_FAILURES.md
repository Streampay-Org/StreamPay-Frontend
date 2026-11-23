# Runbook: Settlement Failures & DLQ Growth

**Service:** Settlement
**On-Call:** Engineering / DevOps
**Severity:** Critical (if paged)

## Symptoms
- `HighStellarSubmissionFailureRate` alert firing.
- `DLQGrowthDetected` alert firing.
- Users reporting "Settle successful" message but on-chain state not updating.

## Potential Causes
1. **Stellar Network Congestion**: High base fees or network instability.
2. **Horizon/Soroban RPC Failure**: The node we are connecting to is down or out of sync.
3. **Smart Contract Bug**: A recent deployment introduced a condition that causes transactions to revert.
4. **Insufficient Funds**: The source account (escrow manager) does not have enough XLM for fees.

## Troubleshooting Steps

1. **Check RPC Health**:
   Verify if the Stellar/Soroban RPC is responsive.
   ```bash
   curl -X POST https://horizon-testnet.stellar.org -d '...' # Replace with actual endpoint
   ```

2. **Check Account Balances**:
   Ensure the StreamPay hot wallet/escrow account has sufficient XLM.

3. **Inspect DLQ Messages**:
   Log into the message queue console (e.g., AWS SQS, RabbitMQ) and inspect the payload of the oldest message in the DLQ. Look for `error_code` or `revert_reason`.

4. **Verify On-Chain**:
   Use a Stellar Explorer (e.g., StellarExpert) to look at recent transactions for the escrow contract address.

## Incident Mode: Disable On-Chain Operations in UI

If the issue is a smart contract bug, Stellar network outage, or any scenario where you need to prevent users from initiating new on-chain transactions:

### Enable Incident Mode (Frontend UI Pause)

**⚠️ Requires rebuild + redeploy (~5-10 minutes)**

1. Set the environment variable:
   ```bash
   NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS=true
   ```

2. Trigger a frontend rebuild and deployment:
   ```bash
   # Example for Vercel
   vercel --prod --env NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS=true
   
   # Or update in your CI/CD platform (GitHub Actions, GitLab CI, etc.)
   # and trigger a new deployment
   ```

3. Verify the deployment:
   - Visit a stream detail page
   - Confirm the warning banner appears: "⚠️ On-chain operations are temporarily paused during incident mode."
   - Confirm all action buttons (Start, Pause, Resume, Withdraw, Cancel) are disabled
   - Test that clicking a disabled button shows: "On-chain operations are temporarily paused during incident mode."

### Enable Backend Enforcement (Global Pause) — Do This First for Immediate Effect

The UI flag only hides buttons; it does NOT block API calls. For actual on-chain enforcement, call the admin pause API immediately:

```bash
curl -X POST https://your-domain.com/api/admin/pause \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"paused": true}'
```

This returns `503 ContractPaused` for `create_stream` and `withdraw` operations instantly (no rebuild needed). `cancel_stream` and `settle` remain allowed so recipients can recover funds.

### Disable Incident Mode (After Resolution)

1. **Lift backend pause first** (instant):
   ```bash
   curl -X POST https://your-domain.com/api/admin/pause \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     -d '{"paused": false}'
   ```

2. **Disable frontend flag** (requires rebuild):
   ```bash
   NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS=false
   # Trigger rebuild + redeploy
   ```

3. Verify UI buttons are re-enabled and warning banner is gone.

## Resolution
- **Congestion**: Increase the `MAX_FEE` setting in the environment variables and restart the service.
- **RPC Failure**: Switch to a secondary RPC provider.
- **Bug**: Roll back the last deployment to the previous stable tag.
- **DLQ**: Once the root cause is fixed, use the `replay-dlq.sh` script to move messages back to the main queue.

## Automated Settlement Job (`POST /api/internal/jobs/settle-ended`)

Streams whose `endTime` has passed remain `active` or `paused` until settled. The internal job `POST /api/internal/jobs/settle-ended` sweeps eligible streams and settles them through the same lock, state machine, Stellar/Soroban settlement client, history, audit log, and webhook outbox path as `POST /api/streams/:id/settle`.

- **Allowed internal services**: `ops-automation`, `settle-worker` (signed via HMAC; see `docs/internal-service-auth.md`). Unauthenticated callers receive a concealed `404`.
- **Request body (optional JSON)**:
  - `dryRun` (`boolean`, default `false`): reports eligible stream IDs without mutating state or calling Stellar.
  - `limit` (`integer`, default `100`, max `500`): maximum number of eligible streams processed per run.
- **Metrics** (exposed in `src/metrics/registry.ts`):
  - `settle_job_runs_total{dry_run="true|false"}`
  - `settle_job_streams_total{result="settled|skipped|failed"}`

### Running a Dry Run

Before triggering a live sweep (especially after an outage or RPC recovery), run a dry run to inspect how many streams are eligible:

```bash
# Sign the request with ops-automation or settle-worker HMAC headers
# Body: {"dryRun": true, "limit": 100}
POST /api/internal/jobs/settle-ended
```

The response returns `scanned`, `eligible`, `processed`, and `candidates` (the stream IDs that would be settled) with `settled: 0` and no state changes.

### Handling Partial Failures

The job processes each eligible stream independently under its per-stream lock. If the Stellar/Soroban settlement client throws for one stream, that stream is left in its prior status, recorded in `failedStreamIds`, and the job continues settling the remaining candidates.

When a run reports `failed > 0`:
1. **Inspect logs & `failedStreamIds`**: Check structured logs for `"Failed to settle ended stream"` with the affected `streamId` values.
2. **Verify RPC & contract health**: Follow the [Troubleshooting Steps](#troubleshooting-steps) above to rule out Horizon/Soroban RPC issues or contract reverts.
3. **Re-run the job safely**: Because already-settled streams are in `ended` status (and `settleStreamById` is idempotent under `withLock`), re-running `POST /api/internal/jobs/settle-ended` will skip previously settled streams and retry only the remaining eligible ones.
4. **Manual fallback**: For a single stuck stream, operators can invoke `POST /api/streams/:id/settle` directly once the underlying chain issue is resolved.

## Post-Mortem
If this alert was a False Positive, update the thresholds in `operations/alerts/streams.yaml`.
