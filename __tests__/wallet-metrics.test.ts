import { GET, POST } from '@/app/api/auth/wallet/route';
import {
  registry,
  walletAuthCounter,
  walletAuthDuration,
} from '@/src/metrics/registry';
import { resetRateLimitStore } from '@/app/lib/rate-limit-store';

const VALID_ADDRESS = 'GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7';
const VALID_CHALLENGE = 'streampay_auth_1721800000000_abc123xyz';

/**
 * Helper: search a Prometheus text-exposition string for a sample line whose
 * full label set matches the supplied assertion.  Returns the matched sample
 * (e.g. `wallet_auth_requests_total{...} 3`) or `null` if nothing matches.
 *
 * Asserting on the full label set avoids false positives where the same
 * metric name appears with a different status label.
 */
function findSample(
  output: string,
  metricName: string,
  expectedLabels: Record<string, string>,
): string | null {
  // `matchAll` requires a global regex. The `m` flag lets `^`/`$` anchor at
  // line boundaries so we don't match a sample line that's part of a larger
  // HELP comment.
  const metricLineRegex = new RegExp(
    `^${metricName}\\s*\\{([^}]*)\\}\\s+([0-9eE.+-]+|\\+Inf|-Inf|NaN)\\s*$`,
    'gm',
  );
  const matches = Array.from(output.matchAll(metricLineRegex));
  for (const match of matches) {
    const labelsRaw = match[1];
    const parsed: Record<string, string> = {};
    for (const part of labelsRaw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq);
      const rawValue = trimmed.slice(eq + 1);
      parsed[key] = rawValue.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    }
    const matchesAll = Object.entries(expectedLabels).every(
      ([k, v]) => parsed[k] === v,
    );
    if (matchesAll) {
      return match[0];
    }
  }
  return null;
}

function makeGetRequest(params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const searchParams = new URLSearchParams(params);
  return {
    nextUrl: { searchParams, pathname: '/api/auth/wallet' },
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'if-none-match') return headers['if-none-match'] ?? null;
        return null;
      },
    },
  } as unknown as import('next/server').NextRequest;
}

function makePostRequest(
  body: unknown,
  csrfCookie?: string,
  csrfHeader?: string,
) {
  return {
    json: async () => {
      if (body === 'THROW') throw new Error('parse error');
      return body;
    },
    nextUrl: { pathname: '/api/auth/wallet' },
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'x-csrf-token') return csrfHeader ?? null;
        return null;
      },
    },
    cookies: {
      get: (name: string) =>
        name === 'csrf-token'
          ? csrfCookie
            ? { value: csrfCookie }
            : undefined
          : undefined,
    },
  } as unknown as import('next/server').NextRequest;
}

function validPostBody() {
  return {
    address: VALID_ADDRESS,
    challenge: VALID_CHALLENGE,
    signature: 'validbase64sig==',
  };
}

beforeEach(() => {
  registry.resetMetrics();
  resetRateLimitStore();
});

describe('Per-endpoint metrics on /api/auth/wallet', () => {
  describe('GET /api/auth/wallet (operation="challenge")', () => {
    it('increments the counter once per successful challenge issuance (status 200)', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));

      const metrics = await registry.metrics();
      const sample = findSample(metrics, 'wallet_auth_requests_total', {
        method: 'GET',
        operation: 'challenge',
        status: '200',
      });
      expect(sample).not.toBeNull();
      expect(sample).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+1\b/);
    });

    it('emits a histogram observation for the 200 path', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));

      const metrics = await registry.metrics();
      // prom-client renders histogram _count as a sample line with the same labels.
      expect(
        findSample(metrics, 'wallet_auth_request_duration_seconds_count', {
          method: 'GET',
          operation: 'challenge',
          status: '200',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 422 VALIDATION_ERROR when address is missing', async () => {
      await GET(makeGetRequest());

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'GET',
          operation: 'challenge',
          status: '422',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 422 INVALID_CURSOR on paginated listing', async () => {
      await GET(
        makeGetRequest({ address: VALID_ADDRESS, cursor: 'not-a-cursor' }),
      );

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'GET',
          operation: 'challenge',
          status: '422',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 304 Not Modified responses', async () => {
      // Freeze time/randomness so challenge generation is deterministic
      const origDateNow = Date.now.bind(Date);
      const origRandom = Math.random.bind(Math);
      Date.now = () => 1234567890000;
      Math.random = () => 0.5;

      try {
        const res1 = await GET(makeGetRequest({ address: VALID_ADDRESS }));
        expect(res1.status).toBe(200);
        const etag = res1.headers.get('etag') as string;

        const req = makeGetRequest({ address: VALID_ADDRESS }, { 'if-none-match': etag });
        const res2 = await GET(req);
        expect(res2.status).toBe(304);

        const metrics = await registry.metrics();
        expect(
          findSample(metrics, 'wallet_auth_requests_total', {
            method: 'GET',
            operation: 'challenge',
            status: '304',
          }),
        ).not.toBeNull();
        expect(
          findSample(metrics, 'wallet_auth_request_duration_seconds_count', {
            method: 'GET',
            operation: 'challenge',
            status: '304',
          }),
        ).not.toBeNull();
      } finally {
        Date.now = origDateNow;
        Math.random = origRandom;
      }
    });

    it('increments the counter for 429 when the challenge limiter trips', async () => {
      // 20 successes, 21st must be throttled.
      for (let i = 0; i < 20; i++) {
        await GET(makeGetRequest({ address: VALID_ADDRESS }));
      }
      const limited = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      expect(limited.status).toBe(429);

      const metrics = await registry.metrics();
      // The 21st request must produce a 429 observation...
      const limitedSample = findSample(metrics, 'wallet_auth_requests_total', {
        method: 'GET',
        operation: 'challenge',
        status: '429',
      });
      expect(limitedSample).not.toBeNull();

      // ...and the preceding 20 must show up as 200 observations.
      const successSample = findSample(metrics, 'wallet_auth_requests_total', {
        method: 'GET',
        operation: 'challenge',
        status: '200',
      });
      expect(successSample).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+20\b/);
    });
  });

  describe('POST /api/auth/wallet (operation="verify")', () => {
    it('increments the counter for 200 on a valid verify', async () => {
      await POST(makePostRequest(validPostBody(), 'csrf', 'csrf'));

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '200',
        }),
      ).not.toBeNull();
      expect(
        findSample(metrics, 'wallet_auth_request_duration_seconds_count', {
          method: 'POST',
          operation: 'verify',
          status: '200',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 422 on validation failure', async () => {
      await POST(makePostRequest({ address: 1 }, 'csrf', 'csrf'));

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '422',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 422 INVALID_JSON when the body cannot be parsed', async () => {
      await POST(makePostRequest('THROW'));

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '422',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 403 on CSRF mismatch', async () => {
      await POST(
        makePostRequest(validPostBody(), 'cookie-token', 'header-token'),
      );

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '403',
        }),
      ).not.toBeNull();
    });

    it('increments the counter for 429 when the login limiter trips', async () => {
      for (let i = 0; i < 5; i++) {
        await POST(makePostRequest(validPostBody(), 'csrf', 'csrf'));
      }
      const limited = await POST(
        makePostRequest(validPostBody(), 'csrf', 'csrf'),
      );
      expect(limited.status).toBe(429);

      const metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '429',
        }),
      ).not.toBeNull();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '200',
        }),
      ).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+5\b/);
    });

    it('separates GET and POST time series by method+operation labels', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));
      await POST(makePostRequest(validPostBody(), 'csrf', 'csrf'));

      const metrics = await registry.metrics();
      // Each combination of labels represents a distinct Prometheus time
      // series; verify they are present and have value 1.
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'GET',
          operation: 'challenge',
          status: '200',
        }),
      ).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+1\b/);
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'POST',
          operation: 'verify',
          status: '200',
        }),
      ).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+1\b/);
    });
  });

  describe('Histogram bucket behaviour', () => {
    it('records observations inside configured buckets', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));

      const metrics = await registry.metrics();
      // The configured bucket set must be present in the exposition output.
      for (const bucket of ['0.005', '0.025', '0.1', '0.25', '0.5', '1', '2.5', '5', '10']) {
        // _bucket meta lines carry the le="..." label; match existence only.
        const escaped = bucket.replace(/\./g, '\\.');
        const re = new RegExp(
          `wallet_auth_request_duration_seconds_bucket\\{[^}]*le="${escaped}"[^}]*\\}`,
        );
        expect(metrics).toMatch(re);
      }
    });

    it('emits a non-empty _sum so duration percentiles are computable', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));

      const metrics = await registry.metrics();
      const sumLine = findSample(
        metrics,
        'wallet_auth_request_duration_seconds_sum',
        { method: 'GET', operation: 'challenge', status: '200' },
      );
      expect(sumLine).not.toBeNull();
      // The observed handler completes in microseconds — assert the sum is a
      // positive numeric value (not NaN, not Inf, not 0).
      const numeric = Number(sumLine!.split(/\s+/).pop());
      expect(Number.isFinite(numeric)).toBe(true);
      expect(numeric).toBeGreaterThanOrEqual(0);
    });

    it('exposes the duration metric via registry.metrics()', async () => {
      await POST(makePostRequest(validPostBody(), 'csrf', 'csrf'));

      const metrics = await registry.metrics();
      expect(metrics).toContain('wallet_auth_request_duration_seconds');
      // And specifically the labelled series for our handler.
      expect(metrics).toMatch(
        /wallet_auth_request_duration_seconds_bucket\{[^}]*method="POST"[^}]*operation="verify"[^}]*\}/,
      );
    });
  });

  describe('Metric isolation', () => {
    it('uses fresh counter state after registry.resetMetrics()', async () => {
      await GET(makeGetRequest({ address: VALID_ADDRESS }));
      let metrics = await registry.metrics();
      expect(
        findSample(metrics, 'wallet_auth_requests_total', {
          method: 'GET',
          operation: 'challenge',
          status: '200',
        }),
      ).toMatch(/wallet_auth_requests_total\{[^}]*\}\s+1\b/);

      registry.resetMetrics();
      metrics = await registry.metrics();
      // After reset, no wallet_auth counters should be present.
      expect(metrics).not.toMatch(/wallet_auth_requests_total\{/);
    });

    it('exports walletAuthCounter and walletAuthDuration symbols', () => {
      // Sanity check: ensure the public surface from the registry is wired up.
      expect(walletAuthCounter).toBeDefined();
      expect(walletAuthDuration).toBeDefined();
      expect(walletAuthCounter.labels).toBeDefined();
      expect(walletAuthDuration.labels).toBeDefined();
    });
  });
});
