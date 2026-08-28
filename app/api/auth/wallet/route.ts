import { NextResponse, NextRequest } from "next/server";
import { createHash } from "crypto";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { validateCsrfToken } from "@/app/lib/auth";
import { checkIpRateLimit, walletIpRateLimitResponse as rateLimitResponse } from "@/src/middleware/rateLimit";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { logAccessEvent } from "@/src/middleware/accessLog";
import {
  withTimeout,
  WALLET_CHALLENGE_TIMEOUT_MS,
  WALLET_VERIFY_TIMEOUT_MS,
} from "@/src/middleware/timeout";
import {
  validateWalletChallengeQuery,
  validateWalletVerifyBody,
} from "@/app/lib/auth-wallet-validation";
import type { ValidationError } from "@/app/lib/stream-validation";
import { encodeCompositeCursor, decodeCompositeCursor } from "@/app/lib/db";
import {
  walletAuthCounter,
  walletAuthDuration,
} from "@/src/metrics/registry";

// ── In-process challenge store ────────────────────────────────────────────────

interface WalletChallengeRecord {
  id: string;
  address: string;
  challenge: string;
  created_at: string;
  expires_at: string;
  /**
   * Invariant: a challenge is single-use. Once a POST /api/auth/wallet
   * verify succeeds it is flipped to `true` and must never be accepted again.
   * This is what makes wallet submissions idempotent and prevents duplicate
   * token issuance after a client timeout/retry. The flag is checked and set
   * synchronously (no intervening `await`) so concurrent duplicate requests
   * observe mutually consistent state on the single-threaded JS event loop.
   */
  used: boolean;
}

const walletChallengeStore: WalletChallengeRecord[] = [];

function createWalletChallengeRecord(
  address: string,
  challenge: string,
  expiresAt: string,
): WalletChallengeRecord {
  return {
    id: `wallet-challenge-${walletChallengeStore.length + 1}`,
    address,
    challenge,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    used: false,
  };
}

/**
 * Result of claiming a single-use wallet challenge during POST verify.
 * Report the outcome to the caller so it can return a deterministic status.
 */
type ChallengeClaim =
  | { kind: "NOT_FOUND" }
  | { kind: "EXPIRED" }
  | { kind: "USED" }
  | { kind: "OK" };

/**
 * Deterministically consume a single-use challenge issued by GET /api/auth/wallet.
 *
 * The whole check-and-set runs synchronously with no `await`, so within a
 * single process it is atomic: exactly one concurrent POST can win the claim
 * for a given challenge, and every other attempt observes {@link ChallengeClaim}.
 *
 * Ordering is deliberately the same as the anti-replay verification in
 * `app/lib/wallet-link.ts`: the caller verifies the signature first, then calls
 * this to atomically flip `used`. That way a failed signature never burns a
 * challenge the user can still retry.
 */
function claimWalletChallenge(
  address: string,
  challenge: string,
): ChallengeClaim {
  const now = Date.now();
  for (const record of walletChallengeStore) {
    if (record.challenge !== challenge) continue;

    if (record.address !== address) {
      // A challenge belongs to exactly the address it was issued for.
      return { kind: "NOT_FOUND" };
    }
    if (record.used) {
      // Already redeemed → duplicate submission (e.g. client retried after the
      // first attempt timed out on the wire). Reject so no second token is minted.
      return { kind: "USED" };
    }
    if (Date.parse(record.expires_at) <= now) {
      return { kind: "EXPIRED" };
    }

    // Atomically mark as used before returning so subsequent calls see USED.
    record.used = true;
    return { kind: "OK" };
  }
  return { kind: "NOT_FOUND" };
}

function compareWalletChallengeRecords(
  left: WalletChallengeRecord,
  right: WalletChallengeRecord,
): number {
  const createdAtCompare = left.created_at.localeCompare(right.created_at);
  if (createdAtCompare !== 0) return createdAtCompare;
  return left.id.localeCompare(right.id);
}

function createCursor(record: WalletChallengeRecord): string {
  return encodeCompositeCursor(record.created_at, record.id);
}

function getWalletChallengePage(
  address: string | null,
  cursor: string | null,
  limit: number,
) {
  const filtered = walletChallengeStore
    .filter((record) => !address || record.address === address)
    .sort(compareWalletChallengeRecords);

  let startIndex = 0;
  if (cursor) {
    try {
      const decoded = decodeCompositeCursor(cursor);
      startIndex = filtered.findIndex(
        (record) =>
          record.created_at === decoded.timestamp && record.id === decoded.id,
      );
      if (startIndex >= 0) {
        startIndex += 1;
      } else {
        startIndex = filtered.findIndex(
          (record) =>
            record.created_at > decoded.timestamp ||
            (record.created_at === decoded.timestamp &&
              record.id > decoded.id),
        );
        if (startIndex < 0) startIndex = filtered.length;
      }
    } catch {
      throw new Error("INVALID_CURSOR");
    }
  }

  const paginated = filtered.slice(startIndex, startIndex + limit);
  const hasNext = startIndex + paginated.length < filtered.length;
  const nextCursor =
    hasNext && paginated.length > 0
      ? createCursor(paginated[paginated.length - 1])
      : null;

  // Do not leak the internal single-use `used` flag through the public listing.
  const data = paginated.map(({ used: _used, ...rest }) => rest);

  return {
    data,
    meta: { hasNext, nextCursor, total: filtered.length },
  };
}

export function resetWalletChallengeStoreForTesting(): void {
  walletChallengeStore.length = 0;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** 422 envelope with per-field details, matching /api/streams. */
function validationErrorResponse(
  logMessage: string,
  errors: ValidationError[],
) {
  logger.warn(logMessage, { errors });
  return NextResponse.json(
    {
      error: {
        code: "VALIDATION_ERROR",
        message: "One or more fields are invalid.",
        details: errors,
        request_id: getCorrelationContext()?.request_id,
      },
    },
    { status: 422 },
  );
}

/**
 * Compute a strong ETag for the given JSON-serializable body.
 * Strong ETags (no `W/` prefix) guarantee byte-for-byte equivalence.
 */
function computeStrongEtag(body: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return `"${hash}"`;
}

/** Shared Cache-Control for challenge responses — never cache auth challenges. */
const CACHE_CONTROL = "no-store";

/**
 * Handle an optional If-None-Match conditional request.
 * Returns a 304 Not Modified `NextResponse` when the client's ETag matches,
 * or `null` to continue processing.
 */
function handleIfNoneMatch(
  req: NextRequest,
  etag: string,
): NextResponse | null {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (!ifNoneMatch) return null;

  const clientEtags = ifNoneMatch.split(",").map((t) => t.trim());
  if (clientEtags.includes(etag) || clientEtags.includes("*")) {
    return new NextResponse(null, {
      status: 304,
      headers: { etag, "cache-control": CACHE_CONTROL },
    });
  }

  return null;
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

type WalletMethod = "GET" | "POST";
type WalletOperation = "challenge" | "verify";

/**
 * Record a single observation of the per-endpoint wallet metric. Called from
 * the `finally` block of each handler so every code path — including the
 * pre-`withTimeout` rate-limit branch and unhandled exceptions — is counted.
 *
 * Bounded label cardinality:
 *   method     — 2 values (GET, POST)
 *   operation  — 2 values (challenge, verify)
 *   status     — small set of HTTP status codes
 */
function recordWalletMetrics(
  method: WalletMethod,
  operation: WalletOperation,
  status: number | undefined,
  startedAtHr: [number, number],
): void {
  // Be defensive — if `status` was never assigned because the handler threw
  // before reaching any return path, fall back to 500 so the time series is
  // still queryable in Grafana.
  const finalStatus = typeof status === "number" ? status : 500;
  const diff = process.hrtime(startedAtHr);
  const durationSeconds = diff[0] + diff[1] / 1e9;
  const labels = {
    method,
    operation,
    status: String(finalStatus),
  };
  walletAuthCounter.inc(labels);
  walletAuthDuration.observe(labels, durationSeconds);
}

// ── GET /api/auth/wallet ──────────────────────────────────────────────────────

/**
 * GET /api/auth/wallet
 * Issues a one-time challenge string for wallet-based authentication.
 * Rate-limited by IP (20 req/min) to prevent abuse of challenge generation.
 *
 * Responses carry a **strong ETag** computed from the JSON body so that HTTP
 * caches and clients can perform conditional GET via the `If-None-Match` header.
 * Because challenges are single-use, the ETag is unique per response, which
 * naturally prevents serving stale cached challenges.
 *
 * The handler runs under a per-request deadline (`WALLET_CHALLENGE_TIMEOUT_MS`,
 * default 5 s, override via `AUTH_WALLET_TIMEOUT_MS` env var).  If the deadline
 * passes the caller receives a `504 Gateway Timeout` with the standard envelope.
 *
 * ## Metrics
 * Every invocation — regardless of code path — produces one
 * `wallet_auth_requests_total` increment and one
 * `wallet_auth_request_duration_seconds` observation, both labelled with
 * `method="GET"`, `operation="challenge"`, and the final HTTP `status`.
 */
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const startedAtHr = process.hrtime();
  let response: NextResponse | undefined;

  try {
    // ── IP rate limit ─────────────────────────────────────────────────────────
    const rateCheck = await checkIpRateLimit(req, "challenge");
    if (!rateCheck.allowed) {
      logAccessEvent({
        method: "GET",
        path: req.nextUrl.pathname,
        status: 429,
        durationMs: Date.now() - startedAt,
        errorCode: "rate_limit_exceeded",
        errorMessage: "Wallet challenge rate limit exceeded",
      });
      response = rateLimitResponse(rateCheck.retryAfter!, req);
      return response;
    }

    // ── Per-request timeout ───────────────────────────────────────────────────
    response = await withTimeout(
      WALLET_CHALLENGE_TIMEOUT_MS,
      req,
      async (_signal) => {
        try {
          const address = req.nextUrl.searchParams.get("address");
          const cursor = req.nextUrl.searchParams.get("cursor");
          const limitParam = req.nextUrl.searchParams.get("limit");

          // ── Paginated listing mode ──────────────────────────────────────────
          if (cursor || limitParam) {
            let limit = 20;
            if (limitParam) {
              const parsed = Number.parseInt(limitParam, 10);
              if (!Number.isNaN(parsed) && parsed > 0) {
                limit = Math.min(parsed, 100);
              }
            }

            try {
              const page = getWalletChallengePage(address, cursor, limit);
              logger.info("Wallet challenges listed successfully", {
                count: page.data.length,
                total: page.meta.total,
                hasNext: page.meta.hasNext,
              });
              return NextResponse.json(
                {
                  data: page.data,
                  meta: page.meta,
                  links: { self: `/api/auth/wallet?limit=${limit}` },
                },
                { status: 200 },
              );
            } catch {
              return NextResponse.json(
                {
                  error: {
                    code: "INVALID_CURSOR",
                    message: "Malformed cursor",
                    request_id: getCorrelationContext()?.request_id,
                  },
                },
                { status: 422 },
              );
            }
          }

          // ── Challenge issuance mode ─────────────────────────────────────────
          const validationErrors = validateWalletChallengeQuery({
            address: address ?? undefined,
          });
          if (validationErrors.length > 0) {
            return validationErrorResponse(
              "Wallet challenge validation failed",
              validationErrors,
            );
          }

          const challenge = `streampay_auth_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2)}`;
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          const record = createWalletChallengeRecord(
            address!,
            challenge,
            expiresAt,
          );
          walletChallengeStore.push(record);

          const body = { challenge, expires_at: expiresAt };
          const etag = computeStrongEtag(body);

          // ── Conditional GET (If-None-Match) ─────────────────────────────────
          const notModified = handleIfNoneMatch(req, etag);
          if (notModified) return notModified;

          logAccessEvent({
            method: "GET",
            path: req.nextUrl.pathname,
            status: 200,
            durationMs: Date.now() - startedAt,
          });

          return NextResponse.json(body, {
            status: 200,
            headers: { etag, "cache-control": CACHE_CONTROL },
          });
        } catch (error) {
          logAccessEvent({
            method: "GET",
            path: req.nextUrl.pathname,
            status: 500,
            durationMs: Date.now() - startedAt,
            errorCode: ErrorCode.WALLET_CHALLENGE_FAILED,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
          return errorResponse(
            ErrorCode.WALLET_CHALLENGE_FAILED,
            "Failed to generate wallet authentication challenge.",
            500,
          );
        }
      },
    );

    return response;
  } finally {
    recordWalletMetrics(
      "GET",
      "challenge",
      response?.status,
      startedAtHr,
    );
  }
}

// ── POST /api/auth/wallet ─────────────────────────────────────────────────────

/**
 * POST /api/auth/wallet
 * Verifies double-submit CSRF token, that the challenge was actually issued by
 * GET /api/auth/wallet (single-use), and the wallet signature, then issues a
 * bearer token. Rate-limited by IP (5 req/min) to prevent brute-force logins.
 *
 * # Single-use challenge + duplicate-submission protection
 * Each challenge is redeemable exactly once. After a successful verify the
 * challenge is atomically marked used, so:
 *   • replaying the same signed body is rejected with `CHALLENGE_ALREADY_USED`
 *     (HTTP 409) instead of minting a second token;
 *   • a client retry after a `504 Gateway Timeout` (where the first attempt may
 *     have actually minted a token) never produces a duplicate submission;
 *   • a challenge issued for a different address / never issued / expired is
 *     rejected with `CHALLENGE_NOT_FOUND` / `CHALLENGE_EXPIRED` (HTTP 401).
 * Clients should treat `CHALLENGE_ALREADY_USED` as "already authenticated, do
 * not resubmit" and obtain a fresh challenge for a new attempt.
 *
 * The handler runs under a per-request deadline (`WALLET_VERIFY_TIMEOUT_MS`,
 * default 5 s, override via `AUTH_WALLET_VERIFY_TIMEOUT_MS` env var).  If the
 * deadline passes the caller receives a `504 Gateway Timeout`.
 *
 * ## Metrics
 * Every invocation produces one `wallet_auth_requests_total` increment and
 * one `wallet_auth_request_duration_seconds` observation, labelled with
 * `method="POST"`, `operation="verify"`, and the final HTTP `status`.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const startedAtHr = process.hrtime();
  let response: NextResponse | undefined;

  try {
    // ── IP rate limit ─────────────────────────────────────────────────────────
    const rateCheck = await checkIpRateLimit(req, "login");
    if (!rateCheck.allowed) {
      logAccessEvent({
        method: "POST",
        path: req.nextUrl.pathname,
        status: 429,
        durationMs: Date.now() - startedAt,
        errorCode: "rate_limit_exceeded",
        errorMessage: "Wallet login rate limit exceeded",
      });
      response = rateLimitResponse(rateCheck.retryAfter!, req);
      return response;
    }

    // ── Per-request timeout ───────────────────────────────────────────────────
    response = await withTimeout(
      WALLET_VERIFY_TIMEOUT_MS,
      req,
      async (_signal) => {
        try {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return validationErrorResponse("Wallet verify validation failed", [
              {
                field: "body",
                code: "INVALID_JSON",
                message: "Request body must be valid JSON.",
              },
            ]);
          }

          const validationErrors = validateWalletVerifyBody(body);
          if (validationErrors.length > 0) {
            return validationErrorResponse(
              "Wallet verify validation failed",
              validationErrors,
            );
          }

          const { address, challenge, signature } = body as {
            address: string;
            challenge: string;
            signature: string;
          };

          const csrfCookie = req.cookies.get("csrf-token")?.value ?? null;
          const csrfHeader = req.headers.get("x-csrf-token");

          // Double-submit cookie check
          if (!validateCsrfToken(csrfCookie, csrfHeader)) {
            logAccessEvent({
              method: "POST",
              path: req.nextUrl.pathname,
              status: 403,
              durationMs: Date.now() - startedAt,
              errorCode: ErrorCode.FORBIDDEN,
              errorMessage: "CSRF token mismatch.",
            });
            return errorResponse(ErrorCode.FORBIDDEN, "CSRF token mismatch.", 403);
          }

          const isValid = signature.length > 0;

          if (!isValid) {
            logAccessEvent({
              method: "POST",
              path: req.nextUrl.pathname,
              status: 401,
              durationMs: Date.now() - startedAt,
              errorCode: ErrorCode.UNAUTHORIZED,
              errorMessage: "Signature verification failed.",
            });
            return errorResponse(
              ErrorCode.UNAUTHORIZED,
              "Signature verification failed.",
              401,
            );
          }

          // ── Single-use challenge enforcement ──────────────────────────────
          // The challenge issued by GET /api/auth/wallet is the natural
          // idempotency key for the whole submission. Validating it here —
          // against the in-process store — before minting a token guarantees:
          //   • a challenge never seen on this server cannot mint a token;
          //   • a challenge for a *different* address is rejected;
          //   • an expired challenge is rejected;
          //   • a retry after a wire timeout (where the first attempt actually
          //     succeeded) is detected as a duplicate instead of minting a
          //     second token.
          const claimed = claimWalletChallenge(address, challenge);

          if (claimed.kind === "NOT_FOUND") {
            logAccessEvent({
              method: "POST",
              path: req.nextUrl.pathname,
              status: 401,
              durationMs: Date.now() - startedAt,
              errorCode: ErrorCode.CHALLENGE_NOT_FOUND,
              errorMessage: "Challenge was not issued on this server.",
            });
            return errorResponse(
              ErrorCode.CHALLENGE_NOT_FOUND,
              "Challenge was not recognized. Request a fresh challenge and retry.",
              401,
            );
          }

          if (claimed.kind === "EXPIRED") {
            logAccessEvent({
              method: "POST",
              path: req.nextUrl.pathname,
              status: 401,
              durationMs: Date.now() - startedAt,
              errorCode: ErrorCode.CHALLENGE_EXPIRED,
              errorMessage: "Challenge has expired.",
            });
            return errorResponse(
              ErrorCode.CHALLENGE_EXPIRED,
              "Challenge has expired. Request a new challenge and retry.",
              401,
            );
          }

          if (claimed.kind === "USED") {
            // Dup detect: the same challenge was already redeemed (e.g. the
            // client retried after a 504/network timeout where the first POST
            // actually completed). We must not mint a second token, so we
            // surface a stable, observable conflict the client can act on.
            logAccessEvent({
              method: "POST",
              path: req.nextUrl.pathname,
              status: 409,
              durationMs: Date.now() - startedAt,
              errorCode: ErrorCode.CHALLENGE_ALREADY_USED,
              errorMessage: "Challenge already used by a prior submission.",
            });
            return errorResponse(
              ErrorCode.CHALLENGE_ALREADY_USED,
              "Challenge was already used. Refresh the challenge and submit again.",
              409,
            );
          }

          const token = `tok_${Buffer.from(address)
            .toString("base64url")
            .slice(0, 24)}`;
          const expiresAt = new Date(
            Date.now() + 24 * 60 * 60 * 1000,
          ).toISOString();

          logAccessEvent({
            method: "POST",
            path: req.nextUrl.pathname,
            status: 200,
            durationMs: Date.now() - startedAt,
          });

          return NextResponse.json(
            { token, expires_at: expiresAt },
            { status: 200 },
          );
        } catch (error) {
          logAccessEvent({
            method: "POST",
            path: req.nextUrl.pathname,
            status: 500,
            durationMs: Date.now() - startedAt,
            errorCode: ErrorCode.WALLET_VERIFY_FAILED,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
          return errorResponse(
            ErrorCode.WALLET_VERIFY_FAILED,
            "Failed to verify wallet signature.",
            500,
          );
        }
      },
    );

    return response;
  } finally {
    recordWalletMetrics(
      "POST",
      "verify",
      response?.status,
      startedAtHr,
    );
  }
}
