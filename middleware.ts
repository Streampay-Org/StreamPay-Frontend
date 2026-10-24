import { NextRequest, NextResponse } from 'next/server';
import { validateConfig } from './app/lib/config/index';
import {
  buildAllowedOriginSet,
  isOriginAllowed,
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  DEFAULT_CORS_MAX_AGE_SECONDS,
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
  resolveRequestId,
} from './lib/requestId';
import { applyChaos, getChaosConfig } from './lib/chaos';
import { touchLastSeenFromRequest } from './lib/lastSeen';

const CANARY_HEADER_NAME = 'X-Canary';

/**
 * API pipeline order: canary/fingerprint setup, chaos fault injection, body
 * size cap, CORS origin rejection/preflight, CSRF validation, then forwarding.
 */

export interface MiddlewareConfig {
  bodyLimits: ReturnType<typeof buildLimitsConfig>;
  allowedOrigins: ReturnType<typeof buildAllowedOriginSet>;
  chaosConfig: ReturnType<typeof getChaosConfig>;
  getCanaryPercentage?: () => number;
}

function resolveMiddlewareConfig(): MiddlewareConfig {
  validateConfig();
  return {
    bodyLimits: buildLimitsConfig(),
    allowedOrigins: buildAllowedOriginSet(process.env.ALLOWED_ORIGINS),
    chaosConfig: getChaosConfig(),
    getCanaryPercentage,
  };
}

function buildCorsHeaders(origin: string) {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', DEFAULT_CORS_METHODS);
  headers.set('Access-Control-Allow-Headers', DEFAULT_CORS_HEADERS);
  headers.set('Access-Control-Max-Age', String(DEFAULT_CORS_MAX_AGE_SECONDS));
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

function getCanarySeed(request: Request): string {
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

function shouldRouteToCanary(request: Request, percentage: number): boolean {
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

export function createMiddleware(middlewareConfig: MiddlewareConfig) {
  const canaryPercentage = middlewareConfig.getCanaryPercentage ?? getCanaryPercentage;

  return async function middleware(request: NextRequest | Request) {
    const requestId = resolveRequestId(request.headers);
    const fingerprint = await captureRequestFingerprint(request);
    const isCanary = shouldRouteToCanary(request, canaryPercentage());
    const pathname = extractPathname(request);
    const finalize = (response: NextResponse): NextResponse => {
      response.headers.set(REQUEST_FINGERPRINT_HEADER, fingerprint);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      setCanaryHeader(response.headers, isCanary);
      return response;
    };

    // ------------------------------------------------------------------
    // 0. Chaos / fault injection (force-disabled in production by
    //    getChaosConfig regardless of env vars)
    // ------------------------------------------------------------------
    const chaosOutcome = await applyChaos(middlewareConfig.chaosConfig);
    if (chaosOutcome.injectedStatus) {
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
      return finalize(chaosResponse);
    }

    touchLastSeenFromRequest(request);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(REQUEST_FINGERPRINT_HEADER, fingerprint);

    if (isCanary) {
      requestHeaders.set(CANARY_HEADER_NAME, 'true');
    }

    const origin = request.headers.get('origin');

    // ------------------------------------------------------------------
    // 1. Request body size cap (O(1) - reads Content-Length)
    // ------------------------------------------------------------------
    const sizeError = checkRequestBodySize(request, middlewareConfig.bodyLimits);
    if (sizeError !== null) {
      return finalize(sizeError);
    }

    // ------------------------------------------------------------------
    // 2. CORS: reject disallowed origins before applying CSRF policy.
    // ------------------------------------------------------------------
    let originAllowed = false;

    if (origin) {
      originAllowed = isOriginAllowed(origin, middlewareConfig.allowedOrigins);

      if (!originAllowed) {
        console.warn(
          JSON.stringify({
            type: 'cors.rejection',
            origin: origin,
            method: request.method,
            pathname,
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
        errorResponse.headers.set('Vary', 'Origin');
        return finalize(errorResponse);
      }

      if (request.method === 'OPTIONS') {
        const headers = buildCorsHeaders(origin);
        headers.set(REQUEST_ID_HEADER, requestId);
        setCanaryHeader(headers, isCanary);
        return finalize(
          new NextResponse(null, {
            status: 204,
            headers,
          }),
        );
      }
    }

    if (request.method === 'OPTIONS' && !origin) {
      const response = new NextResponse(null, { status: 204 });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return finalize(response);
    }

    // ------------------------------------------------------------------
    // 3. CSRF protection for state-changing requests
    // ------------------------------------------------------------------
    if (isCsrfProtectedMethod(request.method) && !isWebhookPath(pathname)) {
      const cookieToken = getCsrfCookieValue(request);
      const headerToken = getCsrfHeaderValue(request);
      if (!validateCsrfToken(cookieToken, headerToken)) {
        return finalize(createCsrfForbiddenResponse(request));
      }
    }

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    // ------------------------------------------------------------------
    // Request-Id propagation
    // ------------------------------------------------------------------
    requestHeaders.set(REQUEST_ID_HEADER, requestId);
    response.headers.set(REQUEST_ID_HEADER, requestId);

    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      const csrfResponse = attachCsrfCookie(response, request);
      if (originAllowed) {
        csrfResponse.headers.set('Access-Control-Allow-Origin', origin!);
        csrfResponse.headers.set('Vary', 'Origin');
      }
      return finalize(csrfResponse);
    }

    // Add CORS headers for allowed origins on non-preflight requests
    if (originAllowed) {
      response.headers.set('Access-Control-Allow-Origin', origin!);
      response.headers.set('Vary', 'Origin');
    }

    return finalize(response);
  };
}

let defaultMiddleware: ReturnType<typeof createMiddleware> | undefined;

export async function middleware(request: NextRequest | Request) {
  defaultMiddleware ??= createMiddleware(resolveMiddlewareConfig());
  return defaultMiddleware(request);
}

export const config = {
  matcher: ['/api/:path*'],
};
