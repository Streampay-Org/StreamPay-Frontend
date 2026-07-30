/**
 * feeBump.ts — GrantFox FWC26 campaign
 *
 * Detects when a Soroban/Stellar transaction submission fails due to
 * insufficient fees and automatically wraps it in a fee-bump transaction
 * using a dedicated fee-bump account.
 *
 * ## How it works
 *
 *   1. After `evaluateWithdrawalState` prepares a withdrawal, the route
 *      handler calls `maybeFeeBump(result)`.
 *   2. If the withdrawal failed with a fee-related error code
 *      (`tx_insufficient_fee`, `tx_too_late`, or an `INSUFFICIENT_FEE`
 *      failure code), we build a fee-bump envelope using the secret key
 *      in `FEE_BUMP_SECRET_KEY`.
 *   3. The bumped transaction is submitted to the configured Horizon
 *      endpoint. On success the stream's `settlementTxHash` is updated
 *      to point at the new fee-bump tx hash.
 *
 * ## Environment variables
 *
 *   - `FEE_BUMP_SECRET_KEY`  — Stellar secret key of the fee-bump payer.
 *                               Must start with 'S' (strkey format).
 *   - `HORIZON_URL`          — Horizon endpoint (defaults to testnet).
 *   - `FEE_BUMP_MAX_FEE`     — Maximum base fee (in stroops) for the
 *                               bumped transaction. Default: 100_000.
 *                               Must be a positive integer ≤ 10_000_000.
 *
 * ## Security considerations
 *
 *   - The secret key is validated at call-time (not module load) to allow
 *     clean test isolation via `process.env` manipulation.
 *   - Secret key values are never logged; only their presence is noted.
 *   - All log entries carry correlation context from `app/lib/logger.ts`.
 *   - Input is validated at the boundary before any network calls.
 */

import type { Stream } from "@/app/types/openapi";
import { logger } from "@/app/lib/logger";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default Horizon URL when HORIZON_URL is not configured. */
const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Default max fee in stroops (0.01 XLM). */
const DEFAULT_MAX_FEE = 100_000;

/** Absolute upper bound on the max-fee to prevent runaway configurations. */
const MAX_FEE_UPPER_BOUND = 10_000_000;

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Result returned by `maybeFeeBump`.
 *
 * - `bumped: true`  — fee-bump succeeded; `newTxHash` is the new on-chain hash.
 * - `bumped: false` — fee-bump was skipped or failed; `error` explains why.
 */
export type FeeBumpResult = {
  bumped: boolean;
  newTxHash?: string;
  error?: string;
};

/** Shape of the evaluation result produced by `evaluateWithdrawalState`. */
type EvaluationResult = {
  stream: Stream;
  alert: boolean;
};

/** Validated, safe config for a single fee-bump attempt. */
type FeeBumpConfig = {
  secretKey: string;
  horizonUrl: string;
  maxFee: number;
};

// ── Input validation ────────────────────────────────────────────────────────

/**
 * Validate and resolve the fee-bump configuration from `process.env`.
 *
 * Reading env vars lazily (inside this function rather than at module load)
 * lets tests set `process.env.*` before the call without Jest module resets.
 *
 * @returns `{ ok: true, config }` or `{ ok: false, error }`.
 */
export function resolveFeeBumpConfig(): { ok: true; config: FeeBumpConfig } | { ok: false; error: string } {
  const secretKey = process.env.FEE_BUMP_SECRET_KEY ?? "";

  // Guard: secret key must be present
  if (!secretKey) {
    return { ok: false, error: "FEE_BUMP_SECRET_KEY is not configured" };
  }

  // Guard: Stellar secret keys start with 'S' (strkey encoding)
  if (!secretKey.startsWith("S")) {
    return {
      ok: false,
      error: "FEE_BUMP_SECRET_KEY does not look like a valid Stellar secret key (expected strkey beginning with 'S')",
    };
  }

  // Validate HORIZON_URL when explicitly set
  const rawHorizon = process.env.HORIZON_URL;
  const horizonUrl = rawHorizon ?? DEFAULT_HORIZON_URL;
  if (rawHorizon !== undefined) {
    try {
      const parsed = new URL(rawHorizon);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: `HORIZON_URL must use http(s) protocol, got '${parsed.protocol}'` };
      }
    } catch {
      return { ok: false, error: `HORIZON_URL is not a valid URL: '${rawHorizon}'` };
    }
  }

  // Validate FEE_BUMP_MAX_FEE
  const rawMaxFee = process.env.FEE_BUMP_MAX_FEE;
  let maxFee = DEFAULT_MAX_FEE;
  if (rawMaxFee !== undefined) {
    const parsed = Number(rawMaxFee);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: `FEE_BUMP_MAX_FEE must be a positive integer, got '${rawMaxFee}'` };
    }
    if (parsed > MAX_FEE_UPPER_BOUND) {
      return {
        ok: false,
        error: `FEE_BUMP_MAX_FEE (${parsed}) exceeds the allowed ceiling of ${MAX_FEE_UPPER_BOUND} stroops`,
      };
    }
    maxFee = parsed;
  }

  return { ok: true, config: { secretKey, horizonUrl, maxFee } };
}

// ── Fee-error detection ────────────────────────────────────────────────────

/**
 * Error codes / substrings that indicate the original transaction failed
 * because of an insufficient fee.
 */
const FEE_ERROR_PATTERNS = [
  "tx_insufficient_fee",
  "tx_too_late",
  "INSUFFICIENT_FEE",
] as const;

/**
 * Returns `true` when the withdrawal result looks like it failed due to
 * an insufficient fee.
 *
 * Checks:
 *   - `stream.withdrawal` must exist.
 *   - `stream.withdrawal.state` must be `"failed"`.
 *   - `stream.withdrawal.failureCode` must contain at least one of the
 *     known fee-error patterns (case-sensitive).
 */
export function isFeeRelatedFailure(result: EvaluationResult): boolean {
  const withdrawal = result.stream.withdrawal;
  if (!withdrawal) return false;
  if (withdrawal.state !== "failed") return false;

  const code = withdrawal.failureCode ?? "";
  return FEE_ERROR_PATTERNS.some((pattern) => code.includes(pattern));
}

// ── Fee-bump logic ─────────────────────────────────────────────────────────

/**
 * If the withdrawal result indicates a fee-related failure **and** the
 * configuration is valid, attempt to wrap the original transaction envelope
 * in a fee-bump transaction and submit it.
 *
 * Returns the original `result` unchanged when:
 *   - The failure is not fee-related.
 *   - Configuration is invalid or missing.
 *   - No `settlementTxHash` is available to look up the original tx.
 *
 * On successful fee-bump submission the stream is mutated in place:
 *   - `stream.settlementTxHash` is updated to the new hash.
 *   - `stream.withdrawal.state` is reset to `"pending"`.
 *   - `stream.withdrawal.failureCode` is cleared.
 *   - `stream.withdrawal.attempts` is reset to `0`.
 *   - `stream.withdrawal.settlementTxHash` is updated to the new hash.
 *
 * All network calls use the injectable `fetcher` parameter so that unit
 * tests can mock HTTP responses without monkey-patching the global `fetch`.
 *
 * @param result  The evaluation result from `evaluateWithdrawalState`.
 * @param fetcher Optional fetch override (defaults to global `fetch`).
 */
export async function maybeFeeBump(
  result: EvaluationResult,
  fetcher: typeof fetch = fetch,
): Promise<{ result: EvaluationResult; feeBump: FeeBumpResult }> {
  const streamId = result.stream.id;

  // ── Guard: not a fee failure ───────────────────────────────────────────
  if (!isFeeRelatedFailure(result)) {
    return { result, feeBump: { bumped: false } };
  }

  logger.info("fee-bump: fee-related failure detected; evaluating eligibility", {
    stream_id: streamId,
    failure_code: result.stream.withdrawal?.failureCode,
  });

  // ── Validate configuration ─────────────────────────────────────────────
  const configResult = resolveFeeBumpConfig();
  if (!configResult.ok) {
    logger.warn("fee-bump: configuration invalid; skipping", {
      stream_id: streamId,
      reason: configResult.error,
    });
    return {
      result,
      feeBump: { bumped: false, error: configResult.error },
    };
  }

  const { secretKey, horizonUrl, maxFee } = configResult.config;

  // ── Guard: must have a tx hash to look up ─────────────────────────────
  const txHash =
    result.stream.settlementTxHash ??
    result.stream.withdrawal?.settlementTxHash;

  if (!txHash) {
    logger.warn("fee-bump: no settlement tx hash available; skipping", {
      stream_id: streamId,
    });
    return {
      result,
      feeBump: {
        bumped: false,
        error: "No settlement tx hash available to fee-bump",
      },
    };
  }

  logger.info("fee-bump: attempting fee-bump", {
    stream_id: streamId,
    original_tx_hash: txHash,
    horizon_url: horizonUrl,
    max_fee: maxFee,
    // Do NOT log secretKey — note only its presence
    fee_payer_configured: true,
  });

  // ── Step 1: Fetch the original transaction envelope from Horizon ───────
  let originalEnvelopeXdr: string;
  try {
    const txRes = await fetcher(
      `${horizonUrl}/transactions/${txHash}`,
      { cache: "no-store" } as RequestInit,
    );
    if (!txRes.ok) {
      const errorMsg = `Failed to fetch original tx: HTTP ${txRes.status}`;
      logger.error("fee-bump: horizon fetch failed", {
        stream_id: streamId,
        original_tx_hash: txHash,
        http_status: txRes.status,
      });
      return { result, feeBump: { bumped: false, error: errorMsg } };
    }

    const txData = (await txRes.json()) as { envelope_xdr?: string };
    if (!txData.envelope_xdr) {
      const errorMsg = "Original transaction has no envelope_xdr";
      logger.error("fee-bump: missing envelope_xdr in Horizon response", {
        stream_id: streamId,
        original_tx_hash: txHash,
      });
      return { result, feeBump: { bumped: false, error: errorMsg } };
    }

    originalEnvelopeXdr = txData.envelope_xdr;
  } catch (err) {
    const errorMsg = `Error fetching original tx: ${err instanceof Error ? err.message : String(err)}`;
    logger.error("fee-bump: unexpected error fetching original tx", {
      stream_id: streamId,
      original_tx_hash: txHash,
      error: err instanceof Error ? err.message : String(err),
    });
    return { result, feeBump: { bumped: false, error: errorMsg } };
  }

  // ── Step 2: Build and submit the fee-bump transaction ─────────────────
  try {
    const feeBumpXdr = buildFeeBumpEnvelope(originalEnvelopeXdr, secretKey, maxFee);

    const submitRes = await fetcher(`${horizonUrl}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: feeBumpXdr }).toString(),
    });

    if (!submitRes.ok) {
      const errorBody = await submitRes.text().catch(() => "unknown");
      const errorMsg = `Fee-bump submission failed: HTTP ${submitRes.status} — ${errorBody}`;
      logger.error("fee-bump: submission rejected by Horizon", {
        stream_id: streamId,
        original_tx_hash: txHash,
        http_status: submitRes.status,
        // Truncate body to avoid log-flooding
        horizon_response: errorBody.slice(0, 500),
      });
      return { result, feeBump: { bumped: false, error: errorMsg } };
    }

    const submitData = (await submitRes.json()) as { hash?: string };
    const newHash = submitData.hash;

    if (!newHash) {
      const errorMsg = "Fee-bump submission succeeded but returned no hash";
      logger.error("fee-bump: success response missing hash field", {
        stream_id: streamId,
        original_tx_hash: txHash,
      });
      return { result, feeBump: { bumped: false, error: errorMsg } };
    }

    // ── Step 3: Update the stream in-place with the new tx hash ───────
    result.stream.settlementTxHash = newHash;
    if (result.stream.withdrawal) {
      result.stream.withdrawal.state = "pending";
      result.stream.withdrawal.failureCode = undefined;
      result.stream.withdrawal.settlementTxHash = newHash;
      result.stream.withdrawal.attempts = 0;
    }

    logger.info("fee-bump: successfully submitted fee-bump transaction", {
      stream_id: streamId,
      original_tx_hash: txHash,
      new_tx_hash: newHash,
    });

    return { result, feeBump: { bumped: true, newTxHash: newHash } };
  } catch (err) {
    const errorMsg = `Fee-bump submission error: ${err instanceof Error ? err.message : String(err)}`;
    logger.error("fee-bump: unexpected error during submission", {
      stream_id: streamId,
      original_tx_hash: txHash,
      error: err instanceof Error ? err.message : String(err),
    });
    return { result, feeBump: { bumped: false, error: errorMsg } };
  }
}

// ── Envelope builder ───────────────────────────────────────────────────────

/**
 * Build a fee-bump transaction envelope XDR string.
 *
 * In a production deployment this would use `@stellar/stellar-sdk` to:
 *   1. Parse `innerEnvelopeXdr` into a `Transaction` object.
 *   2. Construct a `FeeBumpTransaction` that wraps it, signed by the
 *      `secretKey` keypair, with `baseFee` set to `maxFee`.
 *   3. Return the serialised XDR string.
 *
 * This placeholder implementation encodes the intent in a deterministic,
 * human-readable form so the module can be unit-tested end-to-end without
 * pulling in the full SDK at import time.
 *
 * **TODO**: Replace with real `@stellar/stellar-sdk` calls once the SDK
 * is added to `dependencies` (tracked in GrantFox issue #sdk-integration).
 *
 * @param innerEnvelopeXdr  Base64-encoded XDR of the original transaction.
 * @param secretKey         Stellar secret key of the fee-bump payer (not logged).
 * @param maxFee            Maximum base fee in stroops.
 * @returns                 XDR string of the fee-bump envelope.
 *
 * @internal Exported only to allow direct unit-testing of the envelope format.
 */
export function buildFeeBumpEnvelope(
  innerEnvelopeXdr: string,
  secretKey: string,
  maxFee: number,
): string {
  // Tag: fee_bump:<maxFee>:<innerXdr>
  // The secretKey is intentionally not embedded in the tag; it would be used
  // by the real SDK to sign the outer transaction.
  void secretKey; // acknowledged — will be used by real SDK implementation
  return `fee_bump:${maxFee}:${innerEnvelopeXdr}`;
}
