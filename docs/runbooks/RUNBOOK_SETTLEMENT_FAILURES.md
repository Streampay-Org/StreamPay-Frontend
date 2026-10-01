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

## Post-Mortem
If this alert was a False Positive, update the thresholds in `operations/alerts/streams.yaml`.
