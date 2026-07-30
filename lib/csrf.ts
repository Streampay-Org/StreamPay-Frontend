import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestId } from './requestId';

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const CSRF_PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

export function generateCsrfToken(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getCsrfCookieValue(request: NextRequest | Request): string | null {
  if ('cookies' in request && typeof request.cookies?.get === 'function') {
    const cookie = request.cookies.get(CSRF_COOKIE_NAME);
    if (cookie?.value) {
      return normalizeToken(cookie.value);
    }
  }

  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookiePairs = cookieHeader.split(';');
  for (const pair of cookiePairs) {
    const [rawName, ...rawValue] = pair.trim().split('=');
    if (rawName === CSRF_COOKIE_NAME && rawValue.length > 0) {
      return normalizeToken(rawValue.join('='));
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

export function attachCsrfCookie(response: NextResponse, request: NextRequest | Request): NextResponse {
  const existingToken = getCsrfCookieValue(request);
  if (existingToken && /^[a-f0-9]{64}$/i.test(existingToken)) {
    return response;
  }

  const token = generateCsrfToken();
  response.cookies.set(CSRF_COOKIE_NAME, token, {
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
