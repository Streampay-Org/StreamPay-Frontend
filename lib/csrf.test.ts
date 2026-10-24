import {
  CSRF_COOKIE_NAME,
  CSRF_HOST_COOKIE_NAME,
  generateCsrfToken,
  getCsrfCookieName,
  getCsrfCookieValue,
  getCsrfHeaderValue,
  hasBearerCredential,
  hasCookieHeader,
  isCsrfExemptRequest,
  isCsrfProtectedMethod,
  validateCsrfToken,
} from './csrf';

/**
 * `process.env.NODE_ENV` is typed as read-only by the Next.js type
 * definitions, so the test overrides it through a cast.
 */
function setNodeEnv(value: string | undefined) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/**
 * Minimal request stub: the CSRF helpers only read headers and cookies.
 */
function makeRequest(headers: Record<string, string>) {
  const store: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    store[key.toLowerCase()] = value;
  }

  return {
    headers: {
      get: (name: string) => store[name.toLowerCase()] ?? null,
    },
  } as unknown as Request;
}

describe('CSRF helpers', () => {
  describe('validateCsrfToken', () => {
    it('accepts identical tokens', () => {
      expect(validateCsrfToken('abc123', 'abc123')).toBe(true);
    });

    it('rejects mismatching tokens', () => {
      expect(validateCsrfToken('abc123', 'abc124')).toBe(false);
    });

    it('rejects missing tokens', () => {
      expect(validateCsrfToken(null, 'abc123')).toBe(false);
      expect(validateCsrfToken('abc123', null)).toBe(false);
      expect(validateCsrfToken('', '')).toBe(false);
    });
  });

  describe('isCsrfProtectedMethod', () => {
    it('covers the state-changing methods only', () => {
      expect(isCsrfProtectedMethod('POST')).toBe(true);
      expect(isCsrfProtectedMethod('PUT')).toBe(true);
      expect(isCsrfProtectedMethod('PATCH')).toBe(true);
      expect(isCsrfProtectedMethod('DELETE')).toBe(true);
      expect(isCsrfProtectedMethod('GET')).toBe(false);
      expect(isCsrfProtectedMethod('OPTIONS')).toBe(false);
    });
  });

  describe('getCsrfCookieValue', () => {
    it('reads the legacy cookie name', () => {
      const request = makeRequest({ cookie: `${CSRF_COOKIE_NAME}=legacy-token` });
      expect(getCsrfCookieValue(request)).toBe('legacy-token');
    });

    it('reads the host-prefixed cookie name', () => {
      const request = makeRequest({ cookie: `${CSRF_HOST_COOKIE_NAME}=host-token` });
      expect(getCsrfCookieValue(request)).toBe('host-token');
    });

    it('returns null when no CSRF cookie is present', () => {
      expect(getCsrfCookieValue(makeRequest({ cookie: 'other=1' }))).toBeNull();
      expect(getCsrfCookieValue(makeRequest({}))).toBeNull();
    });
  });

  describe('getCsrfHeaderValue', () => {
    it('reads the x-csrf-token header', () => {
      expect(getCsrfHeaderValue(makeRequest({ 'x-csrf-token': 'header-token' }))).toBe(
        'header-token',
      );
      expect(getCsrfHeaderValue(makeRequest({}))).toBeNull();
    });
  });

  describe('hasBearerCredential', () => {
    it('detects bearer and api key credentials', () => {
      expect(hasBearerCredential(makeRequest({ authorization: 'Bearer abc' }))).toBe(true);
      expect(hasBearerCredential(makeRequest({ 'x-api-key': 'key' }))).toBe(true);
      expect(hasBearerCredential(makeRequest({}))).toBe(false);
    });
  });

  describe('hasCookieHeader', () => {
    it('detects any cookie', () => {
      expect(hasCookieHeader(makeRequest({ cookie: 'a=1' }))).toBe(true);
      expect(hasCookieHeader(makeRequest({}))).toBe(false);
    });
  });

  describe('isCsrfExemptRequest', () => {
    it('exempts bearer-only clients that carry no cookie', () => {
      expect(isCsrfExemptRequest(makeRequest({ authorization: 'Bearer abc' }))).toBe(true);
      expect(isCsrfExemptRequest(makeRequest({ 'x-api-key': 'key' }))).toBe(true);
    });

    it('never exempts a request that carries a cookie', () => {
      expect(
        isCsrfExemptRequest(
          makeRequest({ authorization: 'Bearer abc', cookie: 'session=1' }),
        ),
      ).toBe(false);
    });

    it('does not exempt requests without any credential', () => {
      expect(isCsrfExemptRequest(makeRequest({}))).toBe(false);
    });
  });

  describe('generateCsrfToken', () => {
    it('returns a 64 character hex token', () => {
      const token = generateCsrfToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(generateCsrfToken()).not.toBe(token);
    });
  });

  describe('getCsrfCookieName', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      setNodeEnv(originalNodeEnv);
    });

    it('uses the host-prefixed name in production', () => {
      setNodeEnv('production');
      expect(getCsrfCookieName()).toBe(CSRF_HOST_COOKIE_NAME);
    });

    it('uses the legacy name outside production', () => {
      setNodeEnv('test');
      expect(getCsrfCookieName()).toBe(CSRF_COOKIE_NAME);
    });
  });
});
