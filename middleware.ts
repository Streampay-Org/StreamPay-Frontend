import { NextRequest, NextResponse } from 'next/server';
import { validateConfig } from './app/lib/config/index';
import {
  buildAllowedOriginSet,
  buildCorsDecision,
  DEFAULT_CORS_EXPOSE_HEADERS,
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  DEFAULT_CORS_MAX_AGE_SECONDS,
  NULL_ORIGIN,
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
  isCsrfExemptRequest,
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
  headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
  headers.set('Access-Control-Max-Age', String(DEFAULT_CORS_MAX_AGE_SECONDS));
  headers.set('Vary', 'Origin');
  return headers;
}

/**
 * Merge a value into the `Vary` response header instead of overwriting it,
 * so an existing `Vary: Accept-Encoding` is preserved.
 */
function appendVary(headers: Headers, value: string) {
  const existing = headers.get('Vary');

  if (!existing) {
    headers.set('Vary', value);
    return;
  }

  const values = existing
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (values.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    return;
  }

  headers.set('Vary', `${existing}, ${value}`);
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

/**
 * The origin the request was made to.
 *
 * `nextUrl.origin` is used when the request is a `NextRequest`. For a plain
 * `Request` (Edge runtime fallbacks and unit tests) the origin is derived
 * from the request URL. Forwarded headers are deliberately ignored: they are
 * only trustworthy when the deployment runs behind a proxy that sets
 * `TRUST_PROXY`, and a spoofed `x-forwarded-host` must never be able to
 * turn a cross-origin request into a same-origin one.
 */
function resolveRequestOrigin(request: NextRequest | Request): string | null {
  const nextUrl = (request as NextRequest).nextUrl;

  if (nextUrl?.origin) {
    return nextUrl.origin;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return null;
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

    // ------------------------------------------------------------------
    // 1. Request body size cap (O(1) - reads Content-Length)
    // ------------------------------------------------------------------
    const sizeError = checkRequestBodySize(request, middlewareConfig.bodyLimits);
    if (sizeError !== null) {
      return finalize(sizeError);
    }

    // ------------------------------------------------------------------
    // 2. CORS: reject disallowed origins before applying CSRF policy.
    //
    // The decision table lives in `app/lib/cors.ts` so the middleware and
    // the unit tests agree:
    //   - `none`        : no Origin header (not a browser cross-origin request)
    //   - `same-origin` : the request origin matches the request itself, so
    //                    the allowlist does not apply and no CORS headers
    //                    are sent
    //   - `allowed`     : cross-origin and allowlisted
    //   - `null-origin` : `Origin: null` (sandboxed iframe / file://) -> 403
    //   - `denied`      : cross-origin and not allowlisted -> 403
    // ------------------------------------------------------------------
    const corsDecision = buildCorsDecision(
      {
        headers: request.headers,
        nextUrl: (request as NextRequest).nextUrl,
        url: request.url,
        requestOrigin: resolveRequestOrigin(request),
      },
      middlewareConfig.allowedOrigins
    );
    const corsOrigin = corsDecision.origin;
    let originAllowed = false;

    if (corsDecision.kind === 'null-origin') {
      console.warn(
        JSON.stringify({
          type: 'cors.null_origin_rejection',
          origin: corsOrigin,
          method: request.method,
          pathname,
          request_id: requestId,
        })
      );

      const nullOriginResponse = NextResponse.json(
        {
          error: {
            code: 'CORS_ORIGIN_NULL',
            message: `Origin '${NULL_ORIGIN}' is not allowed.`,
            request_id: requestId,
          },
        },
        { status: 403 }
      );
      nullOriginResponse.headers.set('Vary', 'Origin');
      return finalize(nullOriginResponse);
    }

    if (corsDecision.kind === 'denied') {
      console.warn(
        JSON.stringify({
          type: 'cors.rejection',
          origin: corsOrigin,
          method: request.method,
          pathname,
          request_id: requestId,
        })
      );

      const errorResponse = NextResponse.json(
        {
          error: {
            code: 'CORS_ORIGIN_DISALLOWED',
            message: `Origin '${corsOrigin}' is not allowed.`,
            request_id: requestId,
          },
        },
        { status: 403 }
      );
      errorResponse.headers.set('Vary', 'Origin');
      return finalize(errorResponse);
    }

    if (corsDecision.kind === 'allowed') {
      originAllowed = true;

      if (request.method === 'OPTIONS') {
        const headers = buildCorsHeaders(corsOrigin!);
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

    if (request.method === 'OPTIONS' && !originAllowed) {
      const response = new NextResponse(null, { status: 204 });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return finalize(response);
    }

    // ------------------------------------------------------------------
    // 3. CSRF protection for state-changing requests
    //
    // A request that carries no cookie and authenticates with a bearer
    // token or an API key carries no ambient credential, so it cannot be
    // forged by another origin and is exempt from the double-submit token.
    // Requests that carry any cookie are always checked.
    // ------------------------------------------------------------------
    if (
      isCsrfProtectedMethod(request.method) &&
      !isWebhookPath(pathname) &&
      !isCsrfExemptRequest(request)
    ) {
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
        csrfResponse.headers.set('Access-Control-Allow-Origin', corsOrigin!);
        csrfResponse.headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
        appendVary(csrfResponse.headers, 'Origin');
      }
      return finalize(csrfResponse);
    }

    // Add CORS headers for allowed origins on non-preflight requests
    if (originAllowed) {
      response.headers.set('Access-Control-Allow-Origin', corsOrigin!);
      response.headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
      appendVary(response.headers, 'Origin');
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
