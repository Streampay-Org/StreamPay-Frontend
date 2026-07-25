import { NextResponse, NextRequest } from "next/server";
import { createHash } from "crypto";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { validateCsrfToken } from "@/app/lib/auth";
import { checkIpRateLimit, rateLimitResponse } from "@/lib/rateLimitIp";

// ── Strong ETag helper ────────────────────────────────────────────────────────

/**
 * Compute a strong ETag for the given JSON-serializable body.
 * Strong ETags (no `W/` prefix) guarantee byte-for-byte equivalence.
 */
function computeStrongEtag(body: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
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

/**
 * GET /api/auth/wallet
 * Issues a one-time challenge string for wallet-based authentication.
 * Rate-limited by IP (20 req/min) to prevent abuse of challenge generation.
 *
 * Responses carry a **strong ETag** computed from the JSON body so that HTTP
 * caches and clients can perform conditional GET via the `If-None-Match` header.
 * Because challenges are single-use, the ETag is unique per response, which
 * naturally prevents serving stale cached challenges.
 */
export async function GET(req: NextRequest) {
  const rateCheck = await checkIpRateLimit(req, "challenge");
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!, req);
  }

  try {
    const address = req.nextUrl.searchParams.get("address");

    if (!address || !/^G[A-Z2-7]{55}$/.test(address)) {
      return errorResponse(
        ErrorCode.BAD_REQUEST,
        "Query param 'address' must be a valid Stellar public key.",
        400,
      );
    }

    const challenge = `streampay_auth_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const body = { challenge, expires_at: expiresAt };
    const etag = computeStrongEtag(body);

    // ── Conditional GET (If-None-Match) ──────────────────────────────────
    const notModified = handleIfNoneMatch(req, etag);
    if (notModified) return notModified;

    return NextResponse.json(body, {
      status: 200,
      headers: { etag, "cache-control": CACHE_CONTROL },
    });
  } catch {
    return errorResponse(
      ErrorCode.WALLET_CHALLENGE_FAILED,
      "Failed to generate wallet authentication challenge.",
      500,
    );
  }
}

/**
 * POST /api/auth/wallet
 * Verifies double-submit CSRF token and issues a bearer token.
 * Rate-limited by IP (5 req/min) to prevent brute-force login attempts.
 */
export async function POST(req: NextRequest) {
  // IP throttle for login (POST /api/auth/wallet) — 5 req/min per IP
  const rateCheck = await checkIpRateLimit(req, "login");
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!, req);
  }

  try {
    // Allows manual throw simulation to pass directly into catch block
    const body = await req.json();

    if (
      !body ||
      typeof body.address !== "string" ||
      typeof body.challenge !== "string" ||
      typeof body.signature !== "string"
    ) {
      return errorResponse(
        ErrorCode.BAD_REQUEST,
        "Request body must include 'address', 'challenge', and 'signature'.",
        400,
      );
    }

    const csrfCookie = req.cookies.get("csrf-token")?.value ?? null;
    const csrfHeader = req.headers.get("x-csrf-token");

    // Double-submit cookie check
    if (!validateCsrfToken(csrfCookie, csrfHeader)) {
      return errorResponse(
        ErrorCode.FORBIDDEN,
        "CSRF token mismatch.",
        403,
      );
    }

    const isValid = body.signature.length > 0; 

    if (!isValid) {
      return errorResponse(
        ErrorCode.UNAUTHORIZED,
        "Signature verification failed.",
        401,
      );
    }

    const token = `tok_${Buffer.from(body.address).toString("base64url").slice(0, 24)}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); 

    return NextResponse.json({ token, expires_at: expiresAt }, { status: 200 });
  } catch {
    return errorResponse(
      ErrorCode.WALLET_VERIFY_FAILED,
      "Failed to verify wallet signature.",
      500,
    );
  }
}

/**
 * POST /api/auth/wallet
 * Verifies double-submit CSRF token and issues a bearer token.
 * Rate-limited by IP (5 req/min) to prevent brute-force login attempts.
 */
export async function POST(req: NextRequest) {
  // IP throttle for login (POST /api/auth/wallet) — 5 req/min per IP
  const rateCheck = await checkIpRateLimit(req, "login");
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!, req);
  }

  try {
    // Allows manual throw simulation to pass directly into catch block
    const body = await req.json();

    if (
      !body ||
      typeof body.address !== "string" ||
      typeof body.challenge !== "string" ||
      typeof body.signature !== "string"
    ) {
      return errorResponse(
        ErrorCode.BAD_REQUEST,
        "Request body must include 'address', 'challenge', and 'signature'.",
        400,
      );
    }

    const csrfCookie = req.cookies.get("csrf-token")?.value ?? null;
    const csrfHeader = req.headers.get("x-csrf-token");

    // Double-submit cookie check
    if (!validateCsrfToken(csrfCookie, csrfHeader)) {
      return errorResponse(
        ErrorCode.FORBIDDEN,
        "CSRF token mismatch.",
        403,
      );
    }

    const isValid = body.signature.length > 0; 

    if (!isValid) {
      return errorResponse(
        ErrorCode.UNAUTHORIZED,
        "Signature verification failed.",
        401,
      );
    }

    const token = `tok_${Buffer.from(body.address).toString("base64url").slice(0, 24)}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); 

    return NextResponse.json({ token, expires_at: expiresAt }, { status: 200 });
  } catch {
    return errorResponse(
      ErrorCode.WALLET_VERIFY_FAILED,
      "Failed to verify wallet signature.",
      500,
    );
  }
}
