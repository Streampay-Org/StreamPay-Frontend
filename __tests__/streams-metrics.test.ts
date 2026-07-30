import { GET, POST } from '@/app/api/streams/route';
import { registry, streamsCounter, streamsDuration } from '@/src/metrics/registry';
import { resetDb } from '@/app/lib/db';
import { _resetAllowlistForTesting } from '@/app/lib/token-allowlist';
import {
  InMemoryRateLimitStore,
  resetRateLimitStore,
  setRateLimitStore,
} from '@/app/lib/rate-limit-store';

const VALID_STELLAR_KEY =
  'GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA';

function makeGetRequest(query = '') {
  return new Request(`http://localhost/api/streams${query}`);
}

function makePostRequest(body: unknown) {
  return new Request('http://localhost/api/streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/streams per-endpoint metrics', () => {
  let rateLimitStore: InMemoryRateLimitStore;

  beforeEach(() => {
    registry.resetMetrics();
    resetDb();
    _resetAllowlistForTesting();
    rateLimitStore = new InMemoryRateLimitStore(10_000);
    setRateLimitStore(rateLimitStore);
  });

  afterEach(() => {
    rateLimitStore.destroy();
    resetRateLimitStore();
  });

  it('exposes streams counter and histogram metric names', async () => {
    streamsCounter.inc({ method: 'GET', status: '200' });
    streamsDuration.observe({ method: 'GET', status: '200' }, 0.01);

    const metrics = await registry.metrics();
    expect(metrics).toContain('streams_requests_total');
    expect(metrics).toContain('streams_request_duration_seconds');
    expect(metrics).toContain('method="GET"');
    expect(metrics).toContain('status="200"');
  });

  it('records GET /api/streams metrics on success', async () => {
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);

    const metrics = await registry.metrics();
    expect(metrics).toContain('streams_requests_total{method="GET",status="200"} 1');
    expect(metrics).toContain('streams_request_duration_seconds_count{method="GET",status="200"} 1');
  });

  it('records GET /api/streams metrics on validation error', async () => {
    const response = await GET(makeGetRequest('?limit=0'));
    expect(response.status).toBe(422);

    const metrics = await registry.metrics();
    expect(metrics).toContain('streams_requests_total{method="GET",status="422"} 1');
    expect(metrics).toContain('streams_request_duration_seconds_count{method="GET",status="422"} 1');
  });

  it('records POST /api/streams metrics on create', async () => {
    const response = await POST(
      makePostRequest({
        rate: '10',
        recipient: VALID_STELLAR_KEY,
        schedule: 'month',
      }),
    );
    expect(response.status).toBe(201);

    const metrics = await registry.metrics();
    expect(metrics).toContain('streams_requests_total{method="POST",status="201"} 1');
    expect(metrics).toContain('streams_request_duration_seconds_count{method="POST",status="201"} 1');
  });

  it('records POST /api/streams metrics on invalid JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(response.status).toBe(400);

    const metrics = await registry.metrics();
    expect(metrics).toContain('streams_requests_total{method="POST",status="400"} 1');
    expect(metrics).toContain('streams_request_duration_seconds_count{method="POST",status="400"} 1');
  });
});
