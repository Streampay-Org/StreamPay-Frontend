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
});
