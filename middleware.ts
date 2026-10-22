import { NextRequest, NextResponse } from 'next/server';
import { validateConfig } from './app/lib/config/index';
import {
  buildAllowedOriginSet,
  buildCorsDecision,
  buildCorsHeaders,
  mergeVaryHeader,
  DEFAULT_CORS_EXPOSE_HEADERS,
} from './app/lib/cors';
import {
  REQUEST_FINGERPRINT_HEADER,
  captureRequestFingerprint,
} from './lib/fingerprint';
import {
  checkRequestBodySize,
  buildLimitsConfig,
  extractPathname,
  isWebhookPath,
} from './lib/bodySize';
import {
  attachCsrfCookie,
  createCsrfForbiddenResponse,
  getCsrfCookieValue,
  getCsrfHeaderValue,
  isCsrfProtectedMethod,
  validateCsrfToken,
} from './lib/csrf';
import {
  REQUEST_ID_HEADER,
  applyRequestIdPolicy,
  resolveRequestId,
} from './lib/requestId';
import { applyChaos, getChaosConfig } from './lib/chaos';
import { touchLastSeenFromRequest } from './lib/lastSeen';

const bodyLimits = buildLimitsConfig();
validateConfig();
const allowedOrigins = buildAllowedOriginSet(process.env.ALLOWED_ORIGINS);

// Chaos/fault injection config. Resolved once at module init; force-disabled in
// production by getChaosConfig regardless of env vars.
const chaosConfig = getChaosConfig();

const CANARY_HEADER_NAME = 'X-Canary';

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

export async function middleware(request: NextRequest) {
  // ------------------------------------------------------------------
  // 0. Chaos / fault injection (force-disabled in production by
  //    getChaosConfig regardless of env vars)
  // ------------------------------------------------------------------
  const chaosOutcome = await applyChaos(chaosConfig);
  if (chaosOutcome.injectedStatus) {
    const requestId = resolveRequestId(request.headers);
    const chaosResponse = NextResponse.json(
      {
        error: {
          code: 'CHAOS_INJECTED',
          message: 'Chaos injection triggered fault',
          request_id: requestId,
        },
      },
      { status: chaosOutcome.injectedStatus }
    );
    chaosResponse.headers.set(REQUEST_ID_HEADER, requestId);
    return chaosResponse;
  }

  const fingerprint = await captureRequestFingerprint(request);
  touchLastSeenFromRequest(request);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_FINGERPRINT_HEADER, fingerprint);

  const isCanary = shouldRouteToCanary(request);
  if (isCanary) {
    requestHeaders.set(CANARY_HEADER_NAME, 'true');
  }

  const origin = request.headers.get('origin');

  // ------------------------------------------------------------------
  // 1. Request body size cap (O(1) - reads Content-Length)
  // ------------------------------------------------------------------
  const sizeError = checkRequestBodySize(request, bodyLimits);
  if (sizeError !== null) {
    const requestId = resolveRequestId(request.headers);
    sizeError.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
    sizeError.headers.set(REQUEST_ID_HEADER, requestId);
    setCanaryHeader(sizeError.headers, isCanary);
    return sizeError;
  }

  // ------------------------------------------------------------------
  // 2. CORS Gate
  // ------------------------------------------------------------------
  const corsDecision = buildCorsDecision(request, allowedOrigins);

  if (corsDecision.kind === 'null-origin') {
    const requestId = resolveRequestId(request.headers);

    console.warn(
      JSON.stringify({
        type: 'cors.null_origin',
        origin: 'null',
        method: request.method,
        pathname: request.nextUrl?.pathname ?? '',
        request_id: requestId,
      })
    );

    const errorResponse = NextResponse.json(
      {
        error: {
          code: 'CORS_ORIGIN_NULL',
          message: "Origin 'null' is not allowed.",
          request_id: requestId,
        },
      },
      { status: 403 }
    );
    errorResponse.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
    errorResponse.headers.set(REQUEST_ID_HEADER, requestId);
    mergeVaryHeader(errorResponse.headers, 'Origin');
    setCanaryHeader(errorResponse.headers, isCanary);
    return errorResponse;
  }

  if (corsDecision.kind === 'denied') {
    const requestId = resolveRequestId(request.headers);

    console.warn(
      JSON.stringify({
        type: 'cors.rejection',
        origin: origin ?? '',
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
    errorResponse.headers.set(REQUEST_ID_HEADER, requestId);
    mergeVaryHeader(errorResponse.headers, 'Origin');
    setCanaryHeader(errorResponse.headers, isCanary);
    return errorResponse;
  }

  if (request.method === 'OPTIONS') {
    if (corsDecision.kind === 'allowed') {
      const headers = buildCorsHeaders(corsDecision.origin!);
      const requestId = resolveRequestId(request.headers);
      headers.set(REQUEST_ID_HEADER, requestId);
      setCanaryHeader(headers, isCanary);
      return new NextResponse(null, {
        status: 204,
        headers,
      });
    }

    if (corsDecision.kind === 'none' || corsDecision.kind === 'same-origin') {
      const requestId = resolveRequestId(request.headers);
      const response = new NextResponse(null, { status: 204 });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      setCanaryHeader(response.headers, isCanary);
      return response;
    }
  }

  // ------------------------------------------------------------------
  // 3. CSRF protection for state-changing requests
  // ------------------------------------------------------------------
  const pathname = extractPathname(request);
  if (isCsrfProtectedMethod(request.method) && !isWebhookPath(pathname)) {
    const cookieToken = getCsrfCookieValue(request);
    const headerToken = getCsrfHeaderValue(request);
    if (!validateCsrfToken(cookieToken, headerToken)) {
      const response = createCsrfForbiddenResponse(request);
      const requestId = resolveRequestId(request.headers);
      response.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    }
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  setCanaryHeader(response.headers, isCanary);

  // ------------------------------------------------------------------
  // Request-Id propagation
  // ------------------------------------------------------------------
  applyRequestIdPolicy(request.headers, requestHeaders, response.headers);

  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    const csrfResponse = attachCsrfCookie(response, request);
    if (corsDecision.kind === 'allowed') {
      csrfResponse.headers.set('Access-Control-Allow-Origin', corsDecision.origin!);
      csrfResponse.headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
      mergeVaryHeader(csrfResponse.headers, 'Origin');
    }
    setCanaryHeader(csrfResponse.headers, isCanary);
    return csrfResponse;
  }

  // Add CORS headers for allowed cross-origin requests on non-preflight requests
  if (corsDecision.kind === 'allowed') {
    response.headers.set('Access-Control-Allow-Origin', corsDecision.origin!);
    response.headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
    mergeVaryHeader(response.headers, 'Origin');
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
