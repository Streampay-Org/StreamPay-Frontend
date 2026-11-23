/** @jest-environment node */

import {
  buildAllowedOriginSet,
  DEFAULT_CORS_MAX_AGE_SECONDS,
  isOriginAllowed,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveCorsMaxAge,
  WILDCARD_ORIGIN,
} from './cors';
  buildCorsDecision,
  isNullOrigin,
  isOriginAllowed,
  isSameOrigin,
  parseAllowedOrigins,
  normalizeOrigin,
  NULL_ORIGIN,
  WILDCARD_ORIGIN,
} from './cors';

function makeRequest(origin: string | null, requestOrigin = 'https://app.example') {
  const headers = new Headers();
  if (origin !== null) {
    headers.set('origin', origin);
  }

  return {
    headers,
    nextUrl: { origin: requestOrigin },
  };
}

describe('CORS helpers', () => {
  describe('resolveCorsMaxAge', () => {
    it('returns valid configured values', () => {
      expect(resolveCorsMaxAge('120')).toBe(120);
      expect(resolveCorsMaxAge('  7200  ')).toBe(7200);
    });

    it('accepts zero to disable caching', () => {
      expect(resolveCorsMaxAge('0')).toBe(0);
    });

    it('falls back for missing or invalid values', () => {
      expect(resolveCorsMaxAge(undefined)).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('   ')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('-1')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('not-a-number')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('86401')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('1.5')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
      expect(resolveCorsMaxAge('999999999999999999999999999999')).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
    });
  });

  describe('parseAllowedOrigins', () => {
    it('returns an empty list for unset values', () => {
      expect(parseAllowedOrigins(undefined)).toEqual([]);
    });

    it('parses a comma-separated list and trims whitespace', () => {
      expect(parseAllowedOrigins(' https://a.test , http://localhost:3000 ,* ')).toEqual([
        'https://a.test',
        'http://localhost:3000',
        '*',
      ]);
    });
  });

  describe('normalizeOrigin', () => {
    it('returns wildcard origin directly', () => {
      expect(normalizeOrigin(WILDCARD_ORIGIN)).toBe(WILDCARD_ORIGIN);
    });

    it('normalizes valid origin strings', () => {
      expect(normalizeOrigin('https://foo.example.com/')).toBe('https://foo.example.com');
      expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    });
  });

  describe('buildAllowedOriginSet', () => {
    it('builds a normalized origin set from raw values', () => {
      const origins = buildAllowedOriginSet('https://a.test/, http://localhost:3000, *');
      expect(origins.has('https://a.test')).toBe(true);
      expect(origins.has('http://localhost:3000')).toBe(true);
      expect(origins.has('*')).toBe(true);
    });
  });

  describe('isOriginAllowed', () => {
    it('allows exact matches', () => {
      const allowed = ['https://allowed.example.com', 'http://localhost:3000'];
      expect(isOriginAllowed('https://allowed.example.com', allowed)).toBe(true);
      expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true);
    });

    it('rejects unlisted origins', () => {
      const allowed = ['https://allowed.example.com'];
      expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
      expect(isOriginAllowed(null, allowed)).toBe(false);
    });

    it('allows wildcard origin when configured', () => {
      const allowed = buildAllowedOriginSet('*');
      expect(isOriginAllowed('https://anything.example.com', allowed)).toBe(true);
      expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true);
    });

    it('rejects invalid origin header', () => {
      const allowed = ['https://allowed.example.com'];
      expect(isOriginAllowed('not a url', allowed)).toBe(false);
    });
  });

  describe('isNullOrigin', () => {
    it('detects the opaque null origin', () => {
      expect(isNullOrigin(NULL_ORIGIN)).toBe(true);
      expect(isNullOrigin(' NULL ')).toBe(true);
      expect(isNullOrigin('https://app.example')).toBe(false);
      expect(isNullOrigin(null)).toBe(false);
    });
  });

  describe('isSameOrigin', () => {
    it('compares normalised origins', () => {
      expect(isSameOrigin('https://app.example', 'https://app.example')).toBe(true);
      expect(isSameOrigin('https://APP.example:443', 'https://app.example')).toBe(true);
      expect(isSameOrigin('https://other.example', 'https://app.example')).toBe(false);
      expect(isSameOrigin(NULL_ORIGIN, 'https://app.example')).toBe(false);
      expect(isSameOrigin(null, 'https://app.example')).toBe(false);
    });
  });

  describe('buildCorsDecision', () => {
    const allowed = buildAllowedOriginSet('https://partner.example');

    it('reports "none" when no Origin header is present', () => {
      expect(buildCorsDecision(makeRequest(null), allowed)).toEqual({
        kind: 'none',
        origin: null,
      });
    });

    it('treats a same-origin request as same-origin even when it is not allowlisted', () => {
      expect(buildCorsDecision(makeRequest('https://app.example'), allowed)).toEqual({
        kind: 'same-origin',
        origin: 'https://app.example',
      });
    });

    it('treats a default-port, differently cased origin as same-origin', () => {
      expect(buildCorsDecision(makeRequest('https://APP.example:443'), allowed).kind).toBe(
        'same-origin',
      );
    });

    it('allows an allowlisted cross-origin request', () => {
      expect(buildCorsDecision(makeRequest('https://partner.example'), allowed)).toEqual({
        kind: 'allowed',
        origin: 'https://partner.example',
      });
    });

    it('denies an unknown cross-origin request', () => {
      expect(buildCorsDecision(makeRequest('https://evil.example'), allowed)).toEqual({
        kind: 'denied',
        origin: 'https://evil.example',
      });
    });

    it('rejects the opaque null origin explicitly', () => {
      expect(buildCorsDecision(makeRequest(NULL_ORIGIN), allowed)).toEqual({
        kind: 'null-origin',
        origin: NULL_ORIGIN,
      });
    });

    it('does not treat a spoofed forwarded host as same-origin', () => {
      const request = {
        headers: new Headers({ origin: 'https://evil.example' }),
        nextUrl: { origin: 'https://app.example' },
      };

      expect(buildCorsDecision(request, allowed).kind).toBe('denied');
    });
  });
});
