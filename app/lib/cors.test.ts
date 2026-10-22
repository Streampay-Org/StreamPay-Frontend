/** @jest-environment node */

import {
  buildAllowedOriginSet,
  isOriginAllowed,
  parseAllowedOrigins,
  normalizeOrigin,
  WILDCARD_ORIGIN,
  mergeVaryHeader,
  buildCorsDecision,
} from './cors';

describe('CORS helpers', () => {
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
      expect(isOriginAllowed('null', allowed)).toBe(false);
    });
  });

  describe('mergeVaryHeader', () => {
    it('sets Vary when not present', () => {
      const headers = new Headers();
      mergeVaryHeader(headers, 'Origin');
      expect(headers.get('Vary')).toBe('Origin');
    });

    it('appends to existing Vary header', () => {
      const headers = new Headers();
      headers.set('Vary', 'Accept-Encoding');
      mergeVaryHeader(headers, 'Origin');
      expect(headers.get('Vary')).toBe('Accept-Encoding, Origin');
    });

    it('does not duplicate existing Vary value (case-insensitive)', () => {
      const headers = new Headers();
      headers.set('Vary', 'origin');
      mergeVaryHeader(headers, 'Origin');
      expect(headers.get('Vary')).toBe('origin');
    });
  });

  describe('buildCorsDecision', () => {
    const allowed = ['https://allowed.example.com'];

    it('returns none when Origin is missing', () => {
      const decision = buildCorsDecision({ headers: {} }, allowed);
      expect(decision).toEqual({ kind: 'none' });
    });

    it('returns null-origin when Origin is "null"', () => {
      const decision = buildCorsDecision({ headers: { origin: 'null' } }, allowed);
      expect(decision).toEqual({ kind: 'null-origin', origin: 'null' });
    });

    it('returns same-origin when origin matches request origin', () => {
      const decision = buildCorsDecision(
        {
          headers: { origin: 'https://app.example' },
          nextUrl: { origin: 'https://app.example' },
        },
        allowed
      );
      expect(decision).toEqual({ kind: 'same-origin', origin: 'https://app.example' });
    });

    it('normalizes uppercase host and default ports for same-origin comparison', () => {
      const decision = buildCorsDecision(
        {
          headers: { origin: 'https://APP.example:443' },
          nextUrl: { origin: 'https://app.example' },
        },
        allowed
      );
      expect(decision).toEqual({ kind: 'same-origin', origin: 'https://app.example' });
    });

    it('returns allowed for listed cross-origin', () => {
      const decision = buildCorsDecision(
        {
          headers: { origin: 'https://allowed.example.com' },
          nextUrl: { origin: 'https://app.example' },
        },
        allowed
      );
      expect(decision).toEqual({ kind: 'allowed', origin: 'https://allowed.example.com' });
    });

    it('returns denied for unlisted cross-origin', () => {
      const decision = buildCorsDecision(
        {
          headers: { origin: 'https://unlisted.example.com' },
          nextUrl: { origin: 'https://app.example' },
        },
        allowed
      );
      expect(decision).toEqual({ kind: 'denied', origin: 'https://unlisted.example.com' });
    });

    it('does not trust spoofed x-forwarded-host when trustProxy is unset / false', () => {
      const decision = buildCorsDecision(
        {
          headers: {
            origin: 'https://spoofed.example.com',
            'x-forwarded-host': 'spoofed.example.com',
            'x-forwarded-proto': 'https',
          },
          nextUrl: { origin: 'http://localhost:3000' },
        },
        allowed,
        { trustProxy: false }
      );
      expect(decision).toEqual({ kind: 'denied', origin: 'https://spoofed.example.com' });
    });

    it('trusts x-forwarded-host when trustProxy is true', () => {
      const decision = buildCorsDecision(
        {
          headers: {
            origin: 'https://app.example',
            'x-forwarded-host': 'app.example',
            'x-forwarded-proto': 'https',
          },
          nextUrl: { origin: 'http://internal.service:3000' },
        },
        allowed,
        { trustProxy: true }
      );
      expect(decision).toEqual({ kind: 'same-origin', origin: 'https://app.example' });
    });
  });
});
