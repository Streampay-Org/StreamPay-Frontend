import { NextRequest, NextResponse } from "next/server";
import { verifyRequestToken } from "@/app/lib/auth";
import { getTokenDenylist } from "@/app/lib/token-denylist";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { withRouteSpan } from "@/lib/routeSpan";
import { logAccessEvent } from "@/src/middleware/accessLog";
import {
  checkIpRateLimit,
  walletIpRateLimitResponse as rateLimitResponse,
} from "@/src/middleware/rateLimit";

function requestPath(request: NextRequest): string {
  return request.nextUrl?.pathname ?? new URL(request.url).pathname;
}

async function handleLogout(req: NextRequest) {
  const startedAt = Date.now();

  const rateCheck = await checkIpRateLimit(req, "login");
  if (!rateCheck.allowed) {
    logAccessEvent({
      method: "POST",
      path: requestPath(req),
      status: 429,
      durationMs: Date.now() - startedAt,
      errorCode: "rate_limit_exceeded",
      errorMessage: "Logout rate limit exceeded",
    });
    return rateLimitResponse(rateCheck.retryAfter!, req);
  }

  // Verification deliberately ignores the denylist so logging out twice with
  // the same token stays idempotent.
  const verified = verifyRequestToken(req);
  if (!verified) {
    logAccessEvent({
      method: "POST",
      path: requestPath(req),
      status: 401,
      durationMs: Date.now() - startedAt,
      errorCode: ErrorCode.UNAUTHORIZED,
      errorMessage: "Missing or invalid authorization header",
    });
    return errorResponse(
      ErrorCode.UNAUTHORIZED,
      "Missing or invalid authorization header",
      401,
    );
  }

  // Tokens issued before revocation existed carry no `jti`; they cannot be
  // revoked and simply expire on their own.
  if (verified.jti && verified.exp !== undefined) {
    getTokenDenylist().revoke(verified.jti, verified.exp);
  }

  logAccessEvent({
    method: "POST",
    path: requestPath(req),
    status: 204,
    durationMs: Date.now() - startedAt,
  });

  return new NextResponse(null, { status: 204 });
}

export async function POST(req: NextRequest) {
  return withRouteSpan("/api/auth/logout", () => handleLogout(req))(req);
}
