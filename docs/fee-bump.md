# Fee-Bump Support (GrantFox FWC26)

Automatic fee-bump for low-XLM users — when a withdrawal fails because the
transaction fee is too low, StreamPay wraps the original transaction in a
Stellar fee-bump transaction and resubmits it on the user's behalf.

## How it works

```
POST /api/streams/:id/withdraw
  └─ evaluateWithdrawalState(stream)
       └─ maybeFeeBump(result)          ← lib/feeBump.ts
            ├─ isFeeRelatedFailure?     ← checks withdrawal.failureCode
            ├─ resolveFeeBumpConfig()   ← validates env vars at call-time
            ├─ GET  /transactions/:hash ← fetches original envelope from Horizon
            ├─ buildFeeBumpEnvelope()   ← wraps inner tx (TODO: real SDK)
            └─ POST /transactions       ← submits fee-bump to Horizon
```

1. The withdraw route calls `evaluateWithdrawalState`, which sets
   `stream.withdrawal.state = "failed"` and
   `stream.withdrawal.failureCode = "tx_insufficient_fee"` when the
   Horizon response includes one of the known fee-error codes.

2. `maybeFeeBump` detects the failure, validates configuration, fetches
   the original transaction envelope from Horizon, builds a fee-bump
   envelope, and submits it.

3. On success the stream record is updated in-place:
   - `settlementTxHash` → new fee-bump tx hash
   - `withdrawal.state` → `"pending"`
   - `withdrawal.failureCode` → cleared
   - `withdrawal.attempts` → `0`
   - `withdrawal.settlementTxHash` → new fee-bump tx hash

4. The withdraw response includes a `feeBump` field when a bump occurred:
   ```json
   {
     "data": { … },
     "withdrawal": { "state": "pending", … },
     "feeBump": { "bumped": true, "newTxHash": "abc…" }
   }
   ```

## Fee-error detection

The following `failureCode` values (or substrings) trigger a fee-bump:

| Code | Source |
|------|--------|
| `tx_insufficient_fee` | Horizon result code |
| `tx_too_late` | Horizon result code (sequence number expired) |
| `INSUFFICIENT_FEE` | Soroban RPC result code |

Any other failure code (`REORG_DETECTED`, `tx_bad_auth`, etc.) is left
unchanged — no fee-bump is attempted.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEE_BUMP_SECRET_KEY` | **yes** | — | Stellar secret key of the fee-bump payer (strkey, starts with `S`). Never logged. |
| `HORIZON_URL` | no | `https://horizon-testnet.stellar.org` | Horizon endpoint. Must be an `http(s)` URL. |
| `FEE_BUMP_MAX_FEE` | no | `100000` | Maximum base fee in stroops. Positive integer, max `10_000_000`. |

If `FEE_BUMP_SECRET_KEY` is absent or invalid the fee-bump is skipped
silently (the original failure is preserved). No exception is thrown.

### Example `.env.local` configuration

```dotenv
# Fee-bump payer key (testnet — replace for mainnet)
FEE_BUMP_SECRET_KEY=SABCDEFG…

# Optional overrides
HORIZON_URL=https://horizon-testnet.stellar.org
FEE_BUMP_MAX_FEE=100000
```

## Logging

All fee-bump events are emitted as structured JSON log entries via
`app/lib/logger.ts` and include the `stream_id` field for correlation:

| Level | Message | When |
|-------|---------|------|
| `info` | `fee-bump: fee-related failure detected; evaluating eligibility` | Fee error detected |
| `warn` | `fee-bump: configuration invalid; skipping` | Env var validation failed |
| `warn` | `fee-bump: no settlement tx hash available; skipping` | Missing tx hash |
| `info` | `fee-bump: attempting fee-bump` | About to call Horizon |
| `error` | `fee-bump: horizon fetch failed` | Horizon returned non-2xx |
| `error` | `fee-bump: missing envelope_xdr in Horizon response` | Horizon response malformed |
| `error` | `fee-bump: unexpected error fetching original tx` | Network error (fetch) |
| `error` | `fee-bump: submission rejected by Horizon` | Horizon returned non-2xx on submit |
| `error` | `fee-bump: success response missing hash field` | Response shape unexpected |
| `error` | `fee-bump: unexpected error during submission` | Network error (submit) |
| `info` | `fee-bump: successfully submitted fee-bump transaction` | Fee-bump confirmed |

The secret key is **never** included in any log entry. Log fields include
`stream_id`, `original_tx_hash`, `new_tx_hash`, `max_fee`, and HTTP status
codes, but not credentials.

## Security considerations

- **Secret key isolation**: `FEE_BUMP_SECRET_KEY` is read inside
  `resolveFeeBumpConfig()` (not at module load time), which prevents it
  from being captured in module-scope closures and keeps test environments
  isolated.
- **No key logging**: The secret key is explicitly excluded from all
  structured log fields. Tests assert this property.
- **Input validation**: All env vars are validated before any network
  call. An invalid `HORIZON_URL` protocol or a `FEE_BUMP_MAX_FEE` above
  the ceiling (10 M stroops) causes an early, logged return — not a crash.
- **Fee cap**: The `FEE_BUMP_MAX_FEE` ceiling prevents runaway
  configurations from draining the fee-bump account unexpectedly.
- **No silent fallback to mainnet**: `HORIZON_URL` defaults to testnet.
  Switch to mainnet by setting the variable explicitly.

## SDK integration (TODO)

`buildFeeBumpEnvelope()` is currently a **placeholder** that tags the
envelope for testing purposes. To replace it with a real implementation:

1. Add `@stellar/stellar-sdk` to `dependencies` in `package.json`.
2. Replace the body of `buildFeeBumpEnvelope` in `lib/feeBump.ts` with:
   ```ts
   import { FeeBumpTransaction, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

   const inner = new Transaction(innerEnvelopeXdr, Networks.TESTNET);
   const keypair = Keypair.fromSecret(secretKey);
   const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
     keypair,
     String(maxFee),
     inner,
     Networks.TESTNET,
   );
   feeBumpTx.sign(keypair);
   return feeBumpTx.toEnvelope().toXDR("base64");
   ```
3. Remove the `void secretKey` no-op line.
4. Update `buildFeeBumpEnvelope` tests to verify valid XDR output shape.

Tracked in issue: **GrantFox #sdk-integration**.

## Module API

```ts
import {
  isFeeRelatedFailure,  // (result: EvaluationResult) => boolean
  maybeFeeBump,         // (result, fetcher?) => Promise<{result, feeBump}>
  resolveFeeBumpConfig, // () => {ok: true, config} | {ok: false, error}
  buildFeeBumpEnvelope, // (xdr, secretKey, maxFee) => string  [internal]
  type FeeBumpResult,   // {bumped, newTxHash?, error?}
} from "@/lib/feeBump";
```

`isFeeRelatedFailure` and `maybeFeeBump` are the public surface. The
other exports exist solely to support unit testing; treat them as
internal details subject to change when the real SDK is integrated.

## See also

- `lib/feeBump.ts` — implementation
- `lib/feeBump.test.ts` — unit tests (50 cases, ≥98% coverage)
- `app/api/streams/[id]/withdraw/route.ts` — integration point
- `docs/runbooks/RUNBOOK_SETTLEMENT_FAILURES.md` — on-call runbook
- `docs/error-codes.md` — full error code reference
