import { NextRequest, NextResponse } from "next/server";
import { getRateLimitStore, RateLimitStore } from "@/app/lib/rate-limit-store";
import { recordThrottle, recordRequest } from "@/app/lib/rate-limit-metrics";

/**
 * Wallet auth IP rate limits (independent of the general API rate limiter).
 *
 * - challenge (GET): 20 req/min — caps challenge/nonce generation abuse
 * - login (POST): 5 req/min — throttles brute-force login attempts
 */
export const WALLET_RATE_LIMITS = {
  challenge: { limit: 20, windowMs: 60_000 },
  login: { limit: 5, windowMs: 60_000 },
} as const;

export type WalletRateLimitType = keyof typeof WALLET_RATE_LIMITS;

export interface WalletRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

/**
 * Resolve a correlation / request ID for structured logs and error envelopes.
 * Prefers gateway-forwarded headers; falls back to a generated id.
 */
export function resolveCorrelationId(req: NextRequest): string {
  const forwarded =
    req.headers.get("x-request-id") ?? req.headers.get("x-correlation-id");
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.trim();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Extract client IP from proxy headers.
 * Prefer the leftmost X-Forwarded-For entry (original client).
 */
function extractIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return "unknown";
}

/**
 * Check IP-based rate limit for wallet auth operations.
 *
 * @param req - Incoming Next.js request (used for IP + correlation id)
 * @param limitType - "challenge" (GET) or "login" (POST)
 * @param store - Optional store override for tests
 */
export async function checkIpRateLimit(
  req: NextRequest,
  limitType: WalletRateLimitType,
  store?: RateLimitStore
): Promise<WalletRateLimitResult> {
  const ip = extractIp(req);
  const config = WALLET_RATE_LIMITS[limitType];
  const rateLimitStore = store ?? getRateLimitStore();
  const requestId = resolveCorrelationId(req);

  const result = await rateLimitStore.check(
    `${limitType}:${ip}`,
    config.limit,
    config.windowMs
  );

  recordRequest(req.nextUrl.pathname);

  if (!result.allowed) {
    recordThrottle(req.nextUrl.pathname, limitType, "ip", ip);

    // Structured throttle log with correlation ID for ops / SIEM
    console.warn(
      JSON.stringify({
        event: "wallet_ip_rate_limit_exceeded",
        request_id: requestId,
        route: req.nextUrl.pathname,
        limitType,
        identityType: "ip",
        identityDisplay: ip,
        retryAfter: result.retryAfter,
        timestamp: new Date().toISOString(),
      })
    );

    return {
      allowed: false,
      retryAfter: result.retryAfter,
    };
  }

  return { allowed: true };
}

/**
 * Canonical 429 response for wallet IP rate limiting.
 * Includes request_id (error envelope) and Retry-After / x-request-id headers.
 */
export function rateLimitResponse(
  retryAfter: number,
  req?: NextRequest
): NextResponse {
  const request_id = req
    ? resolveCorrelationId(req)
    : `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;

  return NextResponse.json(
    {
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests. Please try again later.",
        request_id,
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "x-request-id": request_id,
      },
    }
  );
}
