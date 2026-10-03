/**
 * @jest-environment node
 *
 * Documentation contract test for `docs/api-client-usage.md` (issue #1648).
 *
 * The page documents the retry / idempotency semantics of `lib/apiClient.ts`
 * so callers stop hand-rolling retry loops that duplicate mutations. Prose is
 * not compiled, so nothing stopped it drifting from the code. These assertions
 * bind the page to the implementation:
 *
 *   - the documented defaults equal the ones in `DEFAULT_OPTIONS`;
 *   - the documented backoff (30 % jitter, 30 s cap) matches
 *     `calculateRetryDelay`;
 *   - one call reuses one `Idempotency-Key` across its own retries, and two
 *     calls never share one — the exact invariant the page promises;
 *   - `x-request-id` is injected, and also has call-scoped lifetime;
 *   - `204` and non-JSON `2xx` both resolve to `null`;
 *   - `fetchForAccount` guards account switches, de-duplicates, and (as the
 *     page warns) mints a fresh idempotency key per coordinator-level retry;
 *   - the client injects no CSRF header, so callers must supply it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  fetchWithIdempotency,
  fetchForAccount,
  AccountFetchCoordinator,
  AccountSwitchedError,
} from '@/lib/apiClient';

const DOC_PATH = join(__dirname, '..', 'api-client-usage.md');
const doc = readFileSync(DOC_PATH, 'utf8');
const CLIENT_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'lib', 'apiClient.ts'),
  'utf8',
);

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** A 2xx JSON response with the given body. */
function jsonResponse(body: unknown, status = 200): unknown {
  return {
    ok: true,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

/** A non-2xx JSON response carrying a StreamPay error envelope. */
function errorResponse(status: number, code: string, message: string): unknown {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: { code, message, request_id: 'req-server' } }),
  };
}

/** Headers of the nth `fetch` invocation, as a real `Headers`. */
function headersOfCall(index: number): Headers {
  return mockFetch.mock.calls[index][1].headers as Headers;
}

// ── Documented defaults ──────────────────────────────────────────────────────

describe('documented defaults', () => {
  it('states a 30 s default timeout, matching DEFAULT_OPTIONS', () => {
    expect(CLIENT_SOURCE).toMatch(/timeoutMs:\s*30000/);
    expect(doc).toContain('30 000 ms (30 s)');
    expect(doc).toMatch(/per attempt/i);
  });

  it('states that retries are off by default', () => {
    expect(CLIENT_SOURCE).toMatch(/retries:\s*0/);
    expect(doc).toMatch(/default retries[^|]*\|\s*\*\*0\*\*/i);
  });

  it('states the 1 s base retry delay', () => {
    expect(CLIENT_SOURCE).toMatch(/retryDelayMs:\s*1000/);
    expect(doc).toContain('1 000 ms');
  });

  it('does not retry a retryable error when `retries` is left at the default', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'));

    await expect(fetchWithIdempotency('/api/v2/streams')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('counts `retries` as additional attempts, not total attempts', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'));

    await expect(
      fetchWithIdempotency('/api/v2/streams', {}, { retries: 2, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('short-circuits non-retryable errors even with retries configured', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(errorResponse(404, 'STREAM_NOT_FOUND', 'gone'));

    await expect(
      fetchWithIdempotency('/api/v2/streams/1', {}, { retries: 3, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'STREAM_NOT_FOUND' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats an unrecognised backend error code as the retryable UNKNOWN_ERROR', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(errorResponse(422, 'WEIRD_NEW_CODE', 'bad'));

    await expect(
      fetchWithIdempotency('/api/v2/streams', {}, { retries: 1, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ERROR' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── Backoff ──────────────────────────────────────────────────────────────────

describe('documented backoff', () => {
  it('matches the jitter and cap described in the page', () => {
    expect(CLIENT_SOURCE).toMatch(/Math\.random\(\) \* 0\.3 \* exponentialDelay/);
    expect(CLIENT_SOURCE).toMatch(/Math\.min\(exponentialDelay \+ jitter, 30000\)/);
    expect(doc).toMatch(/30 % jitter/);
    expect(doc).toContain('30 000 ms');
  });

  it('grows the wait between attempts', async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const started = Date.now();
    await expect(
      fetchWithIdempotency(
        '/api/v2/streams',
        {},
        { retries: 2, retryDelayMs: 120, useExponentialBackoff: true },
      ),
    ).rejects.toBeDefined();

    const elapsed = Date.now() - started;
    // ~120 ms + ~240 ms of sleeping, plus slack for jitter and scheduling.
    expect(elapsed).toBeGreaterThanOrEqual(340);
    expect(elapsed).toBeLessThan(1500);
  });

  it('uses the flat delay when exponential backoff is disabled', async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const started = Date.now();
    await expect(
      fetchWithIdempotency(
        '/api/v2/streams',
        {},
        { retries: 2, retryDelayMs: 40, useExponentialBackoff: false },
      ),
    ).rejects.toBeDefined();

    // Two flat 40 ms sleeps: the 240 ms the exponential path would need is absent.
    expect(Date.now() - started).toBeLessThan(200);
  });
});

// ── Idempotency-Key lifetime ─────────────────────────────────────────────────

describe('documented idempotency-key semantics', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reuses one key across the retries of a single call', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'))
      .mockResolvedValueOnce(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await fetchWithIdempotency('/api/v2/streams', { method: 'POST' }, {
      retries: 2,
      retryDelayMs: 1,
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const keys = [0, 1, 2].map((i) => headersOfCall(i).get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it('mints a fresh key for each separate call', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await fetchWithIdempotency('/api/v2/streams', { method: 'POST' });
    await fetchWithIdempotency('/api/v2/streams', { method: 'POST' });

    expect(headersOfCall(0).get('Idempotency-Key')).not.toBe(
      headersOfCall(1).get('Idempotency-Key'),
    );
  });

  it('preserves a caller-supplied key verbatim on every attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await fetchWithIdempotency(
      '/api/v2/streams',
      { method: 'POST', headers: { 'Idempotency-Key': 'stable-key-1' } },
      { retries: 1, retryDelayMs: 1 },
    );

    expect(headersOfCall(0).get('Idempotency-Key')).toBe('stable-key-1');
    expect(headersOfCall(1).get('Idempotency-Key')).toBe('stable-key-1');
  });

  it('does not add an idempotency key to reads', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await fetchWithIdempotency('/api/v2/streams');

    expect(headersOfCall(0).get('Idempotency-Key')).toBeNull();
    expect(headersOfCall(0).get('Accept')).toBe('application/json');
  });

  it('tells readers a second call is not deduplicated by the server', () => {
    expect(doc).toMatch(/a second call = a new key/i);
    expect(doc).toMatch(/not\*{0,2} deduplicated/i);
  });
});

// ── Request id ───────────────────────────────────────────────────────────────

describe('request correlation', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('injects an x-request-id with call-scoped lifetime', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503, 'SERVICE_UNAVAILABLE', 'down'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await fetchWithIdempotency('/api/v2/streams', {}, { retries: 1, retryDelayMs: 1 });

    const first = headersOfCall(0).get('x-request-id');
    expect(first).toMatch(/^req-[0-9a-z-]+$/);
    expect(headersOfCall(1).get('x-request-id')).toBe(first);
  });
});

// ── Response coercion ────────────────────────────────────────────────────────

describe('documented response coercion', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('resolves 204 to null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: new Headers(),
    });

    await expect(fetchWithIdempotency('/api/v2/streams/1')).resolves.toBeNull();
  });

  it('resolves a non-JSON 2xx to null without reading the body', async () => {
    const json = jest.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/csv' }),
      json,
    });

    await expect(fetchWithIdempotency('/api/exports/large.csv')).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
  });
});

// ── fetchForAccount ──────────────────────────────────────────────────────────

describe('documented fetchForAccount behaviour', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('refuses immediately when the account is not active, without fetching', async () => {
    const coordinator = new AccountFetchCoordinator('GA_ALICE');
    mockFetch.mockResolvedValue(jsonResponse({}));

    await expect(
      fetchForAccount('GA_STALE', '/api/v2/streams', {}, {}, coordinator),
    ).rejects.toBeInstanceOf(AccountSwitchedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('discards a response that resolves after an account switch', async () => {
    const coordinator = new AccountFetchCoordinator('GA_ALICE');
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(jsonResponse({ streams: ['alice'] })), 20);
        }),
    );

    const promise = fetchForAccount('GA_ALICE', '/api/v2/streams', {}, {}, coordinator);
    coordinator.switchAccount('GA_BOB');

    await expect(promise).rejects.toBeInstanceOf(AccountSwitchedError);
  });

  it('de-duplicates concurrent reads of the same method and URL', async () => {
    const coordinator = new AccountFetchCoordinator('GA_ALICE');
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(jsonResponse({ streams: [] })), 10);
        }),
    );

    await Promise.all([
      fetchForAccount('GA_ALICE', '/api/v2/streams', {}, {}, coordinator),
      fetchForAccount('GA_ALICE', '/api/v2/streams', {}, {}, coordinator),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('mints a new idempotency key per coordinator-level retry, as the page warns', async () => {
    const coordinator = new AccountFetchCoordinator('GA_ALICE');
    // A non-retryable 404: the inner client gives up immediately, so the only
    // thing that retries is the coordinator — and it calls the fetcher again.
    mockFetch
      .mockResolvedValueOnce(errorResponse(404, 'STREAM_NOT_FOUND', 'gone'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await fetchForAccount(
      'GA_ALICE',
      '/api/v2/streams',
      { method: 'POST' },
      { retries: 1, retryDelayMs: 1 },
      coordinator,
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(headersOfCall(0).get('Idempotency-Key')).not.toBe(
      headersOfCall(1).get('Idempotency-Key'),
    );
    expect(doc).toMatch(/new\s+`?Idempotency-Key`?/i);
  });

  it('requires callers to handle AccountSwitchedError', () => {
    expect(doc).toContain('AccountSwitchedError');
  });
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

describe('documented CSRF expectations', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });

  it('does not inject a CSRF header, so callers must supply one', async () => {
    await fetchWithIdempotency('/api/v2/streams', { method: 'POST' });
    expect(headersOfCall(0).get('x-csrf-token')).toBeNull();
  });

  it('documents the cookie/header pair and the failure mode', () => {
    expect(doc).toContain('csrf-token');
    expect(doc).toContain('x-csrf-token');
    expect(doc).toContain('403');
    expect(doc).toMatch(/CSRF_TOKEN_INVALID/);
    expect(doc).toMatch(/non-retryable/i);
    expect(doc).toMatch(/csrf-protection\.md/);
  });
});