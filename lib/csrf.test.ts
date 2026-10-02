import { NextRequest, NextResponse } from 'next/server';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_MAX_AGE_SECONDS,
  generateCsrfToken,
  isCsrfProtectedMethod,
  validateCsrfToken,
  getCsrfCookieValue,
  getCsrfHeaderValue,
  attachCsrfCookie,
  createCsrfForbiddenResponse,
} from './csrf';

describe('lib/csrf', () => {
  describe('generateCsrfToken', () => {
    it('generates a 64-character lowercase hex string', () => {
      const token = generateCsrfToken();
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    });

    it('generates distinct unique tokens on each invocation', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i += 1) {
        tokens.add(generateCsrfToken());
      }
      expect(tokens.size).toBe(50);
    });

    it('throws an explicit error when crypto.getRandomValues is unavailable', () => {
      const originalCrypto = globalThis.crypto;
      try {
        // Temporarily override crypto
        Object.defineProperty(globalThis, 'crypto', {
          value: {},
          configurable: true,
          writable: true,
        });

        expect(() => generateCsrfToken()).toThrow(
          'Web Crypto API (crypto.getRandomValues) is required to generate secure CSRF tokens.'
        );
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          value: originalCrypto,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe('isCsrfProtectedMethod', () => {
    it('protects state-mutating HTTP methods', () => {
      expect(isCsrfProtectedMethod('POST')).toBe(true);
      expect(isCsrfProtectedMethod('post')).toBe(true);
      expect(isCsrfProtectedMethod('PUT')).toBe(true);
      expect(isCsrfProtectedMethod('PATCH')).toBe(true);
      expect(isCsrfProtectedMethod('DELETE')).toBe(true);
    });

    it('does not protect safe read-only methods', () => {
      expect(isCsrfProtectedMethod('GET')).toBe(false);
      expect(isCsrfProtectedMethod('HEAD')).toBe(false);
      expect(isCsrfProtectedMethod('OPTIONS')).toBe(false);
    });
  });

  describe('validateCsrfToken', () => {
    const validToken = 'a'.repeat(64);

    it('validates matching cookie and header tokens', () => {
      expect(validateCsrfToken(validToken, validToken)).toBe(true);
    });

    it('trims whitespace when comparing tokens', () => {
      expect(validateCsrfToken(`  ${validToken} `, validToken)).toBe(true);
    });

    it('fails when tokens differ', () => {
      const differentToken = 'b'.repeat(64);
      expect(validateCsrfToken(validToken, differentToken)).toBe(false);
    });

    it('fails when tokens have different lengths', () => {
      expect(validateCsrfToken(validToken, validToken.slice(0, 32))).toBe(false);
    });

    it('fails when cookie token is missing or null', () => {
      expect(validateCsrfToken(null, validToken)).toBe(false);
      expect(validateCsrfToken('', validToken)).toBe(false);
      expect(validateCsrfToken(undefined, validToken)).toBe(false);
    });

    it('fails when header token is missing or null', () => {
      expect(validateCsrfToken(validToken, null)).toBe(false);
      expect(validateCsrfToken(validToken, '')).toBe(false);
      expect(validateCsrfToken(validToken, undefined)).toBe(false);
    });
  });

  describe('getCsrfCookieValue and getCsrfHeaderValue', () => {
    const token = 'c'.repeat(64);

    it('extracts cookie value from NextRequest with cookies helper', () => {
      const request = new NextRequest('http://localhost:3000/api/test', {
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
        },
      });
      expect(getCsrfCookieValue(request)).toBe(token);
    });

    it('extracts cookie value from standard Request cookie header string', () => {
      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          cookie: `other=123; ${CSRF_COOKIE_NAME}=${token}; test=456`,
        },
      });
      expect(getCsrfCookieValue(request)).toBe(token);
    });

    it('returns null if cookie is missing', () => {
      const request = new Request('http://localhost:3000/api/test');
      expect(getCsrfCookieValue(request)).toBeNull();
    });

    it('extracts CSRF token from x-csrf-token header', () => {
      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          [CSRF_HEADER_NAME]: token,
        },
      });
      expect(getCsrfHeaderValue(request)).toBe(token);
    });

    it('returns null if header is missing', () => {
      const request = new Request('http://localhost:3000/api/test');
      expect(getCsrfHeaderValue(request)).toBeNull();
    });
  });

  describe('attachCsrfCookie', () => {
    it('attaches a fresh 64-char CSRF token cookie when none exists', () => {
      const request = new NextRequest('http://localhost:3000/api/test');
      const response = NextResponse.json({ ok: true });

      const modifiedResponse = attachCsrfCookie(response, request);
      const cookie = modifiedResponse.cookies.get(CSRF_COOKIE_NAME);

      expect(cookie).toBeDefined();
      expect(cookie?.value).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(cookie!.value)).toBe(true);
      expect(cookie?.maxAge).toBe(CSRF_COOKIE_MAX_AGE_SECONDS);
      expect(cookie?.sameSite).toBe('lax');
    });

    it('preserves an existing valid 64-hex CSRF cookie without overwriting', () => {
      const existingToken = 'e'.repeat(64);
      const request = new NextRequest('http://localhost:3000/api/test', {
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${existingToken}`,
        },
      });
      const response = NextResponse.json({ ok: true });

      const modifiedResponse = attachCsrfCookie(response, request);
      const cookie = modifiedResponse.cookies.get(CSRF_COOKIE_NAME);

      // Should not set a new cookie when existing one is valid
      expect(cookie).toBeUndefined();
    });

    it('replaces an invalid or non-64-hex existing cookie', () => {
      const invalidToken = 'short-token-123';
      const request = new NextRequest('http://localhost:3000/api/test', {
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${invalidToken}`,
        },
      });
      const response = NextResponse.json({ ok: true });

      const modifiedResponse = attachCsrfCookie(response, request);
      const cookie = modifiedResponse.cookies.get(CSRF_COOKIE_NAME);

      expect(cookie).toBeDefined();
      expect(cookie?.value).toHaveLength(64);
      expect(cookie?.value).not.toBe(invalidToken);
    });
  });

  describe('createCsrfForbiddenResponse', () => {
    it('returns a 403 status with CSRF_TOKEN_INVALID code', async () => {
      const request = new NextRequest('http://localhost:3000/api/test', {
        headers: {
          'x-request-id': 'req_custom_123',
        },
      });

      const response = createCsrfForbiddenResponse(request);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error.code).toBe('CSRF_TOKEN_INVALID');
      expect(body.error.message).toBe('CSRF token validation failed.');
      expect(body.error.request_id).toBe('req_custom_123');
    });
  });
});
