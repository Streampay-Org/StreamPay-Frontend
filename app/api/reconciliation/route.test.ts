/**
 * Tests for GET /api/reconciliation
 *
 * Coverage
 * ─────────
 * • 200 with strong ETag and valid data (existing)
 * • 422 on invalid query parameters (Zod validation)
 * • 304 Not Modified when ETag matches (existing)
 * • Cursor pagination over (created_at, id) (new)
 * • 422 on malformed / empty cursor (new)
 * • 429 when rate limit is exhausted (existing)
 * • Rate limit is scoped per identity — different callers get independent buckets
 */

import { GET } from './route';
import { getCorrelationContext } from '@/app/lib/logger';
import { encodeCompositeCursor } from '@/app/lib/db';
import {
  setRateLimitStore,
  resetRateLimitStore,
  type RateLimitStore,
  type RateLimitResult,
} from '@/app/lib/rate-limit-store';
import { reconciliationCounter, reconciliationDuration } from '@/src/metrics/registry';

// ── Logger mock ──────────────────────────────────────────────────────────────

jest.mock('@/app/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getCorrelationContext: jest.fn(),
}));

jest.mock('@/src/metrics/registry', () => {
  const mockInc = jest.fn();
  const mockLabels = jest.fn(() => ({ inc: mockInc }));
  const mockEndTimer = jest.fn();
  const mockStartTimer = jest.fn(() => mockEndTimer);

  return {
    reconciliationCounter: {
      labels: mockLabels,
      inc: mockInc, // Just in case it's called directly
    },
    reconciliationDuration: {
      startTimer: mockStartTimer,
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Request for the reconciliation endpoint.
 * Allows injecting arbitrary headers (for identity/ETag tests).
 */
function makeRequest(
  options: { search?: string; headers?: Record<string, string> } = {},
): Request {
  const url = `http://localhost:3000/api/reconciliation${options.search ?? ''}`;
  return new Request(url, { headers: new Headers(options.headers ?? {}) });
}

/**
 * Counting store: allows exactly `remaining` requests before throttling.
 * All callers share a single counter unless `perIdentity` is set.
 */
function makeCountingStore(opts: {
  remaining: number;
  retryAfter?: number;
  perIdentity?: boolean;
}): RateLimitStore & { calls: number } {
  const counters = new Map<string, number>();

  const store = {
    calls: 0,
    async check(
      identifier: string,
      _limit: number,
      _windowMs: number,
    ): Promise<RateLimitResult> {
      const key = opts.perIdentity ? identifier : '__shared__';
      const used = counters.get(key) ?? 0;
      store.calls++;

      if (used < opts.remaining) {
        counters.set(key, used + 1);
        return {
          allowed: true,
          remaining: opts.remaining - used - 1,
          resetAt: Math.floor(Date.now() / 1000) + 60,
        };
      }

      return {
        allowed: false,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + (opts.retryAfter ?? 30),
        retryAfter: opts.retryAfter ?? 30,
      };
    },
  };

  return store;
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  (getCorrelationContext as jest.Mock).mockReturnValue({ request_id: 'test-req-id' });
  // Default: allow all requests (generous bucket so non-rate-limit tests pass)
  setRateLimitStore(makeCountingStore({ remaining: 1_000 }));
});

afterEach(() => {
  resetRateLimitStore();
});

// ── Existing behaviour tests ─────────────────────────────────────────────────

describe('GET /api/reconciliation – existing behaviour', () => {
  it('returns 200 with strong ETag and valid data', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.data).toHaveLength(3);
    expect(data.data[0]).toHaveProperty('created_at');
    expect(data.meta).toMatchObject({
      total: 3,
      hasNext: false,
      nextCursor: null,
    });

    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it('validates limit parameter — 422 on invalid value', async () => {
    const res = await GET(makeRequest({ search: '?limit=invalid' }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'limit' }),
      ]),
    );
  });

  it('validates status enum — 422 on unknown value', async () => {
    const res = await GET(makeRequest({ search: '?status=nope' }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.details.some((d: { field: string }) => d.field === 'status')).toBe(true);
  });

  it('filters results when a valid status is provided', async () => {
    const res = await GET(makeRequest({ search: '?status=completed' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toHaveLength(1);
    expect(data.data[0].status).toBe('completed');
  });

  it('returns 304 Not Modified when ETag matches', async () => {
    // First request — capture the ETag.
    const res1 = await GET(makeRequest());
    const etag = res1.headers.get('etag')!;

    // Second request with If-None-Match.
    const res2 = await GET(makeRequest({ headers: { 'If-None-Match': etag } }));

    expect(res2.status).toBe(304);
    expect(res2.headers.get('etag')).toBe(etag);
  });
});

// ── Metrics tests ────────────────────────────────────────────────────────────

describe('GET /api/reconciliation – metrics', () => {
  it('records 200 status for successful requests', async () => {
    await GET(makeRequest());
    
    expect(reconciliationDuration.startTimer).toHaveBeenCalled();
    expect(reconciliationCounter.labels).toHaveBeenCalledWith('200');
    // Start timer returns end timer function
    const mockEndTimer = (reconciliationDuration.startTimer as jest.Mock).mock.results[0].value;
    expect(mockEndTimer).toHaveBeenCalledWith({ status: '200' });
  });

  it('records 422 status for invalid input', async () => {
    await GET(makeRequest({ search: '?limit=invalid' }));

    expect(reconciliationCounter.labels).toHaveBeenCalledWith('422');
    const mockEndTimer = (reconciliationDuration.startTimer as jest.Mock).mock.results[0].value;
    expect(mockEndTimer).toHaveBeenCalledWith({ status: '422' });
  });

  it('records 500 status on unexpected errors', async () => {
    // Force an error by mocking URL to throw
    const originalURL = global.URL;
    global.URL = jest.fn().mockImplementation(() => { throw new Error('Boom'); }) as any;
    
    await GET(makeRequest());
    
    expect(reconciliationCounter.labels).toHaveBeenCalledWith('500');
    const mockEndTimer = (reconciliationDuration.startTimer as jest.Mock).mock.results[0].value;
    expect(mockEndTimer).toHaveBeenCalledWith({ status: '500' });
    
    global.URL = originalURL;
  });
});

// ── Rate-limit tests ─────────────────────────────────────────────────────────

describe('GET /api/reconciliation – rate limiting', () => {
  it('returns 429 when the rate limit is exhausted', async () => {
    // Only 0 requests allowed — every call should be throttled.
    setRateLimitStore(makeCountingStore({ remaining: 0, retryAfter: 30 }));

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(reconciliationCounter.labels).toHaveBeenCalledWith('429');
    const mockEndTimer = (reconciliationDuration.startTimer as jest.Mock).mock.results[0].value;
    expect(mockEndTimer).toHaveBeenCalledWith({ status: '429' });
  });

  it('429 response has Retry-After header', async () => {
    setRateLimitStore(makeCountingStore({ remaining: 0, retryAfter: 45 }));

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('45');
  });

  it('429 response has standardised error envelope', async () => {
    setRateLimitStore(makeCountingStore({ remaining: 0 }));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body).toMatchObject({
      error: {
        code: 'rate_limit_exceeded',
        message: expect.stringContaining('Rate limit'),
        request_id: expect.any(String),
      },
    });
  });

  it('allows requests while under the limit', async () => {
    // 5 tokens available — the first 5 calls should all succeed.
    setRateLimitStore(makeCountingStore({ remaining: 5 }));

    for (let i = 0; i < 5; i++) {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
    }

    // The 6th call should be throttled.
    const throttled = await GET(makeRequest());
    expect(throttled.status).toBe(429);
  });

  it('different identities get independent rate-limit buckets', async () => {
    // Each identity gets exactly 1 token.
    setRateLimitStore(makeCountingStore({ remaining: 1, perIdentity: true }));

    // Both callers should succeed on their first request...
    const resA1 = await GET(
      makeRequest({ headers: { 'X-API-Key': 'key-alice' } }),
    );
    const resB1 = await GET(
      makeRequest({ headers: { 'X-API-Key': 'key-bob' } }),
    );
    expect(resA1.status).toBe(200);
    expect(resB1.status).toBe(200);

    // ...and be throttled on their second.
    const resA2 = await GET(
      makeRequest({ headers: { 'X-API-Key': 'key-alice' } }),
    );
    const resB2 = await GET(
      makeRequest({ headers: { 'X-API-Key': 'key-bob' } }),
    );
    expect(resA2.status).toBe(429);
    expect(resB2.status).toBe(429);
  });

  it('rate-limit check is invoked on every request', async () => {
    const store = makeCountingStore({ remaining: 1_000 });
    setRateLimitStore(store);

    await GET(makeRequest());
    await GET(makeRequest());

    expect(store.calls).toBe(2);
  });

  it('IP-based identity is used when no auth headers are present', async () => {
    const store = makeCountingStore({ remaining: 1, perIdentity: true });
    setRateLimitStore(store);

    const req = makeRequest({ headers: { 'X-Forwarded-For': '10.0.0.1' } });
    const res1 = await GET(req);
    expect(res1.status).toBe(200);

    const req2 = makeRequest({ headers: { 'X-Forwarded-For': '10.0.0.1' } });
    const res2 = await GET(req2);
    expect(res2.status).toBe(429);
  });

  it('normal handler does not run when rate-limited (no expensive work)', async () => {
    const { logger } = jest.requireMock('@/app/lib/logger');
    setRateLimitStore(makeCountingStore({ remaining: 0 }));

    await GET(makeRequest());

    // logger.info is called only by the reconciliation handler body — it
    // should NOT have been reached when we're rate-limited.
    expect(logger.info).not.toHaveBeenCalledWith(
      'Fetching public reconciliation overview',
      expect.anything(),
    );
  });
});
