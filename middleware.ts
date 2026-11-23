import { NextRequest, NextResponse } from 'next/server';
import { validateConfig } from './app/lib/config/index';
import {
  buildAllowedOriginSet,
  isOriginAllowed,
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  resolveCorsMaxAge,
} from './app/lib/cors';
import {
  REQUEST_FINGERPRINT_HEADER,
  captureRequestFingerprint,
} from './lib/fingerprint';
import {
  checkRequestBodySize,
  buildLimitsConfig,
} from './lib/bodySize';
import {
  attachCsrfCookie,
  createCsrfForbiddenResponse,
  getCsrfCookieValue,
  getCsrfHeaderValue,
  isCsrfProtectedMethod,
  validateCsrfToken,
} from './lib/csrf';

// ---------------------------------------------------------------------------
// Request body size cap
// ---------------------------------------------------------------------------
//
// Supports per-route body size limits:
//  - Default routes: 256 KB (override via MAX_STREAM_BODY_BYTES)
//  - Webhook routes (/api/webhooks/*): 1 MB (override via MAX_WEBHOOK_BODY_BYTES)
//
// The check is intentionally O(1): we read the Content-Length header rather
// than buffering the body.  Clients that omit Content-Length are allowed
// through — the application layer is responsible for streaming limits.
//
// Only write methods (POST, PUT, PATCH) are checked; safe methods (GET, HEAD,
// OPTIONS, DELETE) are not expected to carry a body and are skipped.

// Build limits configuration at module initialization
const bodyLimits = buildLimitsConfig();

// Validate configuration at middleware initialization so invalid CORS settings fail early.
validateConfig();

const allowedOrigins = buildAllowedOriginSet(process.env.ALLOWED_ORIGINS);
const corsMaxAgeSeconds = resolveCorsMaxAge(process.env.CORS_MAX_AGE_SECONDS);

// Chaos/fault injection config. Resolved once at module init; force-disabled in
// production by getChaosConfig regardless of env vars.
const chaosConfig = getChaosConfig();

export const config = {
  matcher: ['/api/:path*'],
};

const CANARY_HEADER_NAME = 'X-Canary';

function buildCorsHeaders(origin: string) {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', DEFAULT_CORS_METHODS);
  headers.set('Access-Control-Allow-Headers', DEFAULT_CORS_HEADERS);
  headers.set('Access-Control-Max-Age', String(corsMaxAgeSeconds));
  headers.set('Vary', 'Origin');
  return headers;
}

function getCanaryPercentage(): number {
  const rawValue = process.env.CANARY_PERCENTAGE;
  if (rawValue === undefined || rawValue.trim() === '') {
    return 0;
  }

  const parsedValue = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsedValue)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.trunc(parsedValue)));
}

function getCanarySeed(request: NextRequest): string {
  return (
    request.headers.get('x-tenant-id') ??
    request.headers.get('x-user-id') ??
    request.headers.get('x-forwarded-user') ??
    request.headers.get('authorization') ??
    request.url
  );
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Deterministically bucket requests by a stable tenant/user-derived seed so
// the same identity consistently lands in the same canary cohort.
function shouldRouteToCanary(request: NextRequest): boolean {
  const percentage = getCanaryPercentage();
  if (percentage <= 0) {
    return false;
  }

  if (percentage >= 100) {
    return true;
  }

  const seed = getCanarySeed(request);
  const bucket = hashSeed(seed) % 100;
  return bucket < percentage;
}

function setCanaryHeader(headers: Headers, isCanary: boolean) {
  if (isCanary) {
    headers.set(CANARY_HEADER_NAME, 'true');
  }
}

function resolveRequestId(request: NextRequest): string {
  const forwarded = request.headers.get('x-request-id');
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.trim();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

  return pathname.startsWith('/api/');
}

export async function middleware(request: NextRequest) {
  const fingerprint = await captureRequestFingerprint(request);
  touchLastSeenFromRequest(request);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_FINGERPRINT_HEADER, fingerprint);

  const isCanary = shouldRouteToCanary(request);
  if (isCanary) {
    requestHeaders.set(CANARY_HEADER_NAME, 'true');
  }

  const origin = request.headers.get('origin');
  let isAllowed = false;

  // ------------------------------------------------------------------
  // 1. Request body size cap (O(1) — reads Content-Length)
  // ------------------------------------------------------------------
  const sizeError = checkRequestBodySize(request, bodyLimits);
  if (sizeError !== null) {
    sizeError.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
    setCanaryHeader(sizeError.headers, isCanary);
    return sizeError;
  }

  // ------------------------------------------------------------------
  // 2. CSRF protection for state-changing requests
  // ------------------------------------------------------------------
  if (isCsrfProtectedMethod(request.method)) {
    const cookieToken = getCsrfCookieValue(request);
    const headerToken = getCsrfHeaderValue(request);
    if (!validateCsrfToken(cookieToken, headerToken)) {
      const response = createCsrfForbiddenResponse(request);
      response.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
      return response;
    }
  }

  // ------------------------------------------------------------------
  // 3. CORS
  // ------------------------------------------------------------------
  const origin = request.headers.get('origin');
  let originAllowed = false;

  if (origin) {
    originAllowed = isOriginAllowed(origin, allowedOrigins);

    if (!originAllowed) {
      const requestId =
        request.headers.get('x-request-id') ??
        `req_${Date.now().toString(36)}`;

      console.warn(
        JSON.stringify({
          type: 'cors.rejection',
          origin,
          method: request.method,
          pathname: request.nextUrl?.pathname ?? '',
          request_id: requestId,
        })
      );

      const errorResponse = NextResponse.json(
        {
          error: {
            code: 'CORS_ORIGIN_DISALLOWED',
            message: `Origin '${origin}' is not allowed.`,
            request_id: requestId,
          },
        },
        { status: 403 }
      );
      errorResponse.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
      errorResponse.headers.set('Vary', 'Origin');
      setCanaryHeader(errorResponse.headers, isCanary);
      return errorResponse;
    }

    if (request.method === 'OPTIONS') {
      const headers = buildCorsHeaders(origin);
      setCanaryHeader(headers, isCanary);
      return new NextResponse(null, {
        status: 204,
        headers,
      });
    }
  }

  if (request.method === 'OPTIONS' && !origin) {
    const response = new NextResponse(null, { status: 204 });
    setCanaryHeader(response.headers, isCanary);
    return response;
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    const csrfResponse = attachCsrfCookie(response, request);
    if (originAllowed) {
      csrfResponse.headers.set('Access-Control-Allow-Origin', origin!);
      csrfResponse.headers.set('Vary', 'Origin');
    }
    return csrfResponse;
  }

  if (originAllowed) {
    const headers = response.headers;
    headers.set('Access-Control-Allow-Origin', origin!);
    headers.set('Vary', 'Origin');
  }

  return response;
}
