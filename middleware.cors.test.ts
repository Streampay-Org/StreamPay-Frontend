/** @jest-environment node */

import { NextRequest } from 'next/server';

describe('Middleware CORS gate', () => {
  let middleware: any;

  beforeEach(async () => {
    jest.resetModules();

    (process.env as any).STELLAR_NETWORK = 'testnet';
    (process.env as any).JWT_SECRET = 'test-secret-at-least-32-characters-long';
    (process.env as any).NODE_ENV = 'production';
    (process.env as any).ALLOWED_ORIGINS = 'https://allowed.example.com';
    delete (process.env as any).TRUST_PROXY;

    const imported = await import('./middleware');
    middleware = imported.middleware;
  });

  afterEach(() => {
    delete (process.env as any).STELLAR_NETWORK;
    delete (process.env as any).JWT_SECRET;
    delete (process.env as any).NODE_ENV;
    delete (process.env as any).ALLOWED_ORIGINS;
    delete (process.env as any).TRUST_PROXY;
  });

  // Scenario 1: Same-origin POST not in allowlist passes through without 403
  it('Scenario 1: allows same-origin POST not in allowlist to pass through without 403 or CORS headers', async () => {
    const request = new NextRequest('https://app.example/api/x', {
      method: 'POST',
      headers: {
        origin: 'https://app.example',
        'x-csrf-token': 'valid-csrf-token',
        cookie: 'csrf-token=valid-csrf-token',
      },
    });

    const response = await middleware(request);

    expect(response.status).not.toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Scenario 2: Cross-origin, listed -> 200, with ACAO set and Vary containing Origin
  it('Scenario 2: allows listed cross-origin request with ACAO and Vary: Origin', async () => {
    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'GET',
      headers: {
        origin: 'https://allowed.example.com',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  // Scenario 3: Cross-origin, not listed -> 403 CORS_ORIGIN_DISALLOWED
  it('Scenario 3: rejects unlisted cross-origin request with 403 CORS_ORIGIN_DISALLOWED', async () => {
    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'GET',
      headers: {
        origin: 'https://evil.example.com',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'CORS_ORIGIN_DISALLOWED',
        message: "Origin 'https://evil.example.com' is not allowed.",
        request_id: expect.any(String),
      },
    });
    expect(response.headers.get('vary')).toBe('Origin');
  });

  // Scenario 4: Origin: null -> 403 CORS_ORIGIN_NULL
  it('Scenario 4: rejects Origin: null with 403 CORS_ORIGIN_NULL and distinct log type', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'GET',
      headers: {
        origin: 'null',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'CORS_ORIGIN_NULL',
        message: "Origin 'null' is not allowed.",
        request_id: expect.any(String),
      },
    });
    expect(response.headers.get('vary')).toBe('Origin');

    expect(warnSpy).toHaveBeenCalled();
    const logCall = warnSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.type === 'cors.null_origin';
      } catch {
        return false;
      }
    });
    expect(logCall).toBeDefined();

    warnSpy.mockRestore();
  });

  // Scenario 5: Origin: https://APP.example:443 against host app.example -> treated as same-origin
  it('Scenario 5: treats normalized Origin with uppercase host and default port as same-origin', async () => {
    const request = new NextRequest('https://app.example/api/x', {
      method: 'POST',
      headers: {
        origin: 'https://APP.example:443',
        'x-csrf-token': 'csrf-token-123',
        cookie: 'csrf-token=csrf-token-123',
      },
    });

    const response = await middleware(request);

    expect(response.status).not.toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Scenario 6: x-forwarded-host spoofed while TRUST_PROXY is unset -> not treated as same-origin
  it('Scenario 6: does not treat request as same-origin when x-forwarded-host is spoofed and TRUST_PROXY is unset', async () => {
    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'GET',
      headers: {
        origin: 'https://spoofed.example.com',
        'x-forwarded-host': 'spoofed.example.com',
        'x-forwarded-proto': 'https',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('CORS_ORIGIN_DISALLOWED');
  });

  // Scenario 7 & 8: Expose headers & Vary merge
  it('Scenario 7 & 8: sets Access-Control-Expose-Headers and preserves/merges Vary header', async () => {
    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'GET',
      headers: {
        origin: 'https://allowed.example.com',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(200);
    const exposeHeaders = response.headers.get('access-control-expose-headers');
    expect(exposeHeaders).toBeDefined();
    expect(exposeHeaders).toContain('x-request-id');
    expect(exposeHeaders).toContain('retry-after');
    expect(exposeHeaders).toContain('etag');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('preflight OPTIONS request from allowed cross-origin returns 204 with full CORS headers', async () => {
    const request = new NextRequest('https://api.example.com/api/health', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://allowed.example.com',
        'access-control-request-method': 'POST',
      },
    });

    const response = await middleware(request);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(response.headers.get('access-control-expose-headers')).toContain('x-request-id');
    expect(response.headers.get('vary')).toBe('Origin');
  });
});
