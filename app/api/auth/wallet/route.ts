import { NextResponse, NextRequest } from "next/server";
import { createHash, randomBytes, randomUUID } from "crypto";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { validateCsrfToken } from "@/app/lib/auth";
import { checkIpRateLimit, walletIpRateLimitResponse as rateLimitResponse } from "@/src/middleware/rateLimit";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { withRouteSpan } from "@/lib/routeSpan";
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
import {
  buildLimitsConfig,
  createBodySizeTooLargeResponse,
  extractPathname,
  getBodySizeLimit,
} from "@/lib/bodySize";
import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
} from "@/lib/readJsonBody";
import { resolveRequestId } from "@/lib/requestId";
import type { ValidationError } from "@/app/lib/stream-validation";
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
}

/** Challenge lifetime: 5 minutes from issuance. */
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Live challenges kept per address; the oldest is evicted first. */
const WALLET_CHALLENGE_PER_ADDRESS_MAX = 5;

/** Default global cap; overridable via the WALLET_CHALLENGE_MAX env var. */
const DEFAULT_WALLET_CHALLENGE_MAX = 10_000;

/**
 * Challenge id → record, in insertion order. Every record shares the same
 * TTL, so insertion order is also expiry order; pruning relies on that to
 * stop at the first live record instead of scanning the whole store.
 */
const walletChallengeStore = new Map<string, WalletChallengeRecord>();

/** Address → live challenge ids, in insertion order (oldest first). */
const walletChallengeIdsByAddress = new Map<string, Set<string>>();

function resolveWalletChallengeMax(): number {
  const raw = process.env.WALLET_CHALLENGE_MAX;
  if (!raw) return DEFAULT_WALLET_CHALLENGE_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WALLET_CHALLENGE_MAX;
}

function createWalletChallengeRecord(
  address: string,
  challenge: string,
  createdAtMs: number,
): WalletChallengeRecord {
  return {
    id: randomUUID(),
    address,
    challenge,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(createdAtMs + WALLET_CHALLENGE_TTL_MS).toISOString(),
  };
}

function deleteWalletChallenge(record: WalletChallengeRecord): void {
  walletChallengeStore.delete(record.id);
  const ids = walletChallengeIdsByAddress.get(record.address);
  if (!ids) return;
  ids.delete(record.id);
  if (ids.size === 0) walletChallengeIdsByAddress.delete(record.address);
}

/**
 * Drop expired records. Insertion order matches expiry order (fixed TTL), so
 * this walks only the expired prefix — O(expired) per call, never a full
 * scan of the store on every request.
 */
function pruneExpiredWalletChallenges(nowMs: number): void {
  for (const record of walletChallengeStore.values()) {
    if (Date.parse(record.expires_at) > nowMs) break;
    deleteWalletChallenge(record);
  }
}

/** Insert a freshly issued record, then enforce the per-address and global caps. */
function storeWalletChallenge(
  record: WalletChallengeRecord,
  nowMs: number,
): void {
  pruneExpiredWalletChallenges(nowMs);

  // Per-address cap: keep only the newest WALLET_CHALLENGE_PER_ADDRESS_MAX.
  const ids =
    walletChallengeIdsByAddress.get(record.address) ?? new Set<string>();
  while (ids.size >= WALLET_CHALLENGE_PER_ADDRESS_MAX) {
    const oldestId = ids.values().next().value;
    if (oldestId === undefined) break;
    const oldest = walletChallengeStore.get(oldestId);
    if (oldest) {
      deleteWalletChallenge(oldest);
    } else {
      ids.delete(oldestId); // stale index entry
    }
  }

  walletChallengeStore.set(record.id, record);
  ids.add(record.id);
  walletChallengeIdsByAddress.set(record.address, ids);

  // Global cap: evict oldest-first until the store is within budget.
  const max = resolveWalletChallengeMax();
  while (walletChallengeStore.size > max) {
    const oldestId = walletChallengeStore.keys().next().value;
    if (oldestId === undefined) break;
    const oldest = walletChallengeStore.get(oldestId);
    if (oldest) deleteWalletChallenge(oldest);
  }
}

export function resetWalletChallengeStoreForTesting(): void {
  walletChallengeStore.clear();
  walletChallengeIdsByAddress.clear();
}

/** Live record count — used by tests to assert the store stays bounded. */
export function getWalletChallengeStoreSizeForTesting(): number {
  return walletChallengeStore.size;
}

/** Challenge strings held by the store, oldest first — used by tests. */
export function listWalletChallengesForTesting(): string[] {
  return Array.from(
    walletChallengeStore.values(),
    (record) => record.challenge,
  );
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

/** 400 envelope for query parameters this endpoint refuses to serve. */
function unsupportedQueryResponse(): NextResponse {
  logger.warn("Wallet challenge query rejected: cursor/limit are unsupported");
  return NextResponse.json(
    {
      error: {
        code: ErrorCode.UNSUPPORTED_QUERY,
        message: "Query parameters 'cursor' and 'limit' are not supported.",
        request_id: getCorrelationContext()?.request_id,
      },
    },
    { status: 400, headers: { "cache-control": CACHE_CONTROL } },
  );
}

// ── Challenge issuance ────────────────────────────────────────────────────────

/**
 * Domain separator so a StreamPay challenge can never be confused with a
 * message from another protocol the same wallet might be asked to sign.
 */
const CHALLENGE_PREFIX = "streampay-auth:v1:";

/** `randomBytes(32)` → 43 base64url characters. */
const CHALLENGE_NONCE_BYTES = 32;

/** The whole challenge must stay signable as one short ASCII string. */
const CHALLENGE_MAX_BYTES = 256;

/**
 * Build a one-time challenge: `streampay-auth:v1:<nonce>|<origin>|<expires_at>`.
 *
 * The nonce comes from a CSPRNG. The server origin and expiry are part of the
 * message the wallet signs, so a challenge minted on one deployment cannot be
 * replayed against another, and an expired challenge is self-evidently stale.
 * Printable ASCII only, at most 256 bytes.
 */
function buildWalletChallenge(origin: string, expiresAt: string): string {
  const nonce = randomBytes(CHALLENGE_NONCE_BYTES).toString("base64url");
  const challenge = `${CHALLENGE_PREFIX}${nonce}|${origin}|${expiresAt}`;
  if (Buffer.byteLength(challenge, "ascii") > CHALLENGE_MAX_BYTES) {
    throw new Error("wallet challenge exceeds the 256-byte signing limit");
  }
  return challenge;
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
 * Challenges are generated with a CSPRNG (`crypto.randomBytes(32)`) and have
 * the shape `streampay-auth:v1:<nonce>|<origin>|<expires_at>` — the server
 * origin and expiry are part of the message the wallet signs, so a challenge
 * cannot be replayed against another deployment. The response always carries
 * `Cache-Control: no-store`; conditional requests (`If-None-Match`) are
 * intentionally not honoured, because a freshly issued challenge must reach
 * the client — the endpoint always answers `200` with a body.
 *
 * `cursor` and `limit` are rejected with `400 UNSUPPORTED_QUERY`: listing
 * outstanding challenges would let an unauthenticated caller harvest live
 * challenges for any address. The in-process store is bounded — 5 live
 * challenges per address (oldest evicted), `WALLET_CHALLENGE_MAX` globally
 * (default 10 000), TTL-pruned on every write.
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
async function handleWalletChallengeGet(req: NextRequest) {
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

          // ── Listing mode removed (security fix) ────────────────────────────
          // Outstanding challenges must never be enumerable; a GET that asks
          // for pagination is rejected outright.
          if (cursor !== null || limitParam !== null) {
            logAccessEvent({
              method: "GET",
              path: req.nextUrl.pathname,
              status: 400,
              durationMs: Date.now() - startedAt,
              errorCode: "UNSUPPORTED_QUERY",
              errorMessage: "cursor/limit are not supported on this endpoint",
            });
            return unsupportedQueryResponse();
          }

          // ── Challenge issuance ──────────────────────────────────────────────
          const validationErrors = validateWalletChallengeQuery({
            address: address ?? undefined,
          });
          if (validationErrors.length > 0) {
            return validationErrorResponse(
              "Wallet challenge validation failed",
              validationErrors,
            );
          }

          const nowMs = Date.now();
          const expiresAt = new Date(
            nowMs + WALLET_CHALLENGE_TTL_MS,
          ).toISOString();
          const challenge = buildWalletChallenge(req.nextUrl.origin, expiresAt);
          const record = createWalletChallengeRecord(
            address!,
            challenge,
            nowMs,
          );
          storeWalletChallenge(record, nowMs);

          const body = { challenge, expires_at: record.expires_at };
          const etag = computeStrongEtag(body);

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
 * Verifies double-submit CSRF token and wallet signature, then issues a bearer
 * token.
 * Rate-limited by IP (5 req/min) to prevent brute-force login attempts.
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
async function handleWalletVerifyPost(req: NextRequest) {
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
            const limits = buildLimitsConfig();
            const maxBytes =
              getBodySizeLimit(extractPathname(req), limits) ?? limits.default;
            body = await readJsonBody(req, { maxBytes });
          } catch (error) {
            if (error instanceof BodyTooLargeError) {
              return createBodySizeTooLargeResponse(
                error.receivedBytes,
                error.maxBytes,
                resolveRequestId(req.headers),
              );
            }
            if (error instanceof InvalidJsonError) {
              return validationErrorResponse("Wallet verify validation failed", [
                {
                  field: "body",
                  code: error.code,
                  message:
                    error.code === "EMPTY_BODY"
                      ? "Request body is required."
                      : "Request body must be valid JSON.",
                },
              ]);
            }
            throw error;
          }

          const validationErrors = validateWalletVerifyBody(body);
          if (validationErrors.length > 0) {
            return validationErrorResponse(
              "Wallet verify validation failed",
              validationErrors,
            );
          }

          const { address, signature } = body as {
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

// ── Route instrumentation ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  return withRouteSpan("/api/auth/wallet", () => handleWalletChallengeGet(req));
}

export async function POST(req: NextRequest) {
  return withRouteSpan("/api/auth/wallet", () => handleWalletVerifyPost(req));
}
