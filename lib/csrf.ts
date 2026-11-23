import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestId } from './requestId';

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Host-only cookie name used in production.
 *
 * The `__Host-` prefix is rejected by browsers unless the cookie is `Secure`,
 * has `Path=/` and carries no `Domain`, which prevents a sub-domain from
 * setting (or "tossing") a CSRF token the app would trust.
 */
export const CSRF_HOST_COOKIE_NAME = '__Host-csrf-token';

/** Cookie names accepted when reading the double-submit token. */
export const CSRF_COOKIE_NAMES: ReadonlyArray<string> = [
  CSRF_HOST_COOKIE_NAME,
  CSRF_COOKIE_NAME,
];

const CSRF_PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes exempt from CSRF enforcement.
 *
 * `/api/client-errors` is a public, unauthenticated ingestion endpoint
 * used by the client-side error reporter. It cannot rely on a CSRF cookie
 * because it is fired from error boundaries (including during hydration
 * failures) and via `navigator.sendBeacon`, which cannot attach custom
 * headers. The exemption is safe because:
 *   - the route accepts only `text/plain` or `application/json` bodies;
 *   - it cannot read or authorize any cookie-derived session and performs
 *     no state-changing operation on behalf of the user;
 *   - it is rate-limited per identity and size-capped.
 */
export const CSRF_EXEMPT_ROUTES: ReadonlyArray<string> = ['/api/client-errors'];

function normalizeToken(token: string | null | undefined): string | null {
  if (typeof token !== 'string') {
    return null;
  }

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index];
  }

  return result === 0;
}

export function isCsrfProtectedMethod(method: string): boolean {
  return CSRF_PROTECTED_METHODS.has(method.toUpperCase());
}

export function isCsrfExemptRoute(pathname: string): boolean {
  return CSRF_EXEMPT_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

/**
 * The cookie name used to mint new CSRF tokens.
 *
 * Production uses the `__Host-` prefixed name; every other environment keeps
 * the historical `csrf-token` name.
 */
export function getCsrfCookieName(): string {
  return process.env.NODE_ENV === 'production' ? CSRF_HOST_COOKIE_NAME : CSRF_COOKIE_NAME;
}

export function generateCsrfToken(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = new Uint8Array(32);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    // 122 bits of CSPRNG output, zero padded to the 64 hex character format.
    return cryptoApi.randomUUID().replace(/-/g, '').padEnd(64, '0');
  }

  throw new Error(
    'CSRF token generation requires a cryptographically secure random source (crypto.getRandomValues).',
  );
}

export function getCsrfCookieValue(request: NextRequest | Request): string | null {
  if ('cookies' in request && typeof request.cookies?.get === 'function') {
    for (const name of CSRF_COOKIE_NAMES) {
      const cookie = request.cookies.get(name);
      if (cookie?.value) {
        const value = normalizeToken(cookie.value);
        if (value) {
          return value;
        }
      }
    }
  }

  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookiePairs = cookieHeader.split(';');
  for (const pair of cookiePairs) {
    const [rawName, ...rawValue] = pair.trim().split('=');
    const name = rawName.trim();

    if (!CSRF_COOKIE_NAMES.includes(name)) {
      continue;
    }

    const value = normalizeToken(rawValue.join('='));
    if (value) {
      return value;
    }
  }

  return null;
}

export function getCsrfHeaderValue(request: NextRequest | Request): string | null {
  return normalizeToken(request.headers.get(CSRF_HEADER_NAME));
}

export function validateCsrfToken(cookieToken: string | null, headerToken: string | null): boolean {
  const normalizedCookie = normalizeToken(cookieToken);
  const normalizedHeader = normalizeToken(headerToken);

  if (!normalizedCookie || !normalizedHeader) {
    return false;
  }

  try {
    const cookieBytes = new TextEncoder().encode(normalizedCookie);
    const headerBytes = new TextEncoder().encode(normalizedHeader);
    return timingSafeEqual(cookieBytes, headerBytes);
  } catch {
    return false;
  }
}

/**
 * True when the request carries a non-ambient credential.
 *
 * `Authorization: Bearer …` and `X-API-Key` are attached by the client, not
 * by the browser automatically, so a cross-site request cannot forge them.
 */
export function hasBearerCredential(request: NextRequest | Request): boolean {
  const authorization = request.headers.get('authorization');

  if (authorization) {
    const scheme = authorization.trim().split(/\s+/)[0]?.toLowerCase();
    if (scheme === 'bearer') {
      return true;
    }
  }

  const apiKey = request.headers.get('x-api-key');
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * True when the request carries any cookie at all.
 */
export function hasCookieHeader(request: NextRequest | Request): boolean {
  const cookie = request.headers.get('cookie');
  return typeof cookie === 'string' && cookie.trim().length > 0;
}

/**
 * CSRF only threatens requests that carry ambient credentials (cookies).
 *
 * A request without any cookie that authenticates with a bearer token or an
 * API key cannot be forged by another origin, so the double-submit token is
 * not required. Requests that carry cookies are always checked, even when a
 * bearer token is present.
 */
export function isCsrfExemptRequest(request: NextRequest | Request): boolean {
  if (hasCookieHeader(request)) {
    return false;
  }

  return hasBearerCredential(request);
}

export function attachCsrfCookie(response: NextResponse, request: NextRequest | Request): NextResponse {
  const existingToken = getCsrfCookieValue(request);
  if (existingToken && /^[a-f0-9]{64}$/i.test(existingToken)) {
    return response;
  }

  const token = generateCsrfToken();
  response.cookies.set(getCsrfCookieName(), token, {
    path: '/',
    maxAge: CSRF_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false,
  });

  return response;
}

export function createCsrfForbiddenResponse(request: NextRequest | Request): NextResponse {
  const requestId = resolveRequestId(request.headers);
  return NextResponse.json(
    {
      error: {
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token validation failed.',
        request_id: requestId,
      },
    },
    { status: 403 },
  );
}
