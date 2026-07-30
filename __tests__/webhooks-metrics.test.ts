import { GET, POST } from '@/app/api/webhooks/route';
import { registry, webhookCounter, webhookDuration } from '@/src/metrics/registry';
import { NextRequest } from 'next/server';
import { resetRateLimitStore } from '@/app/lib/rate-limit-store';

jest.mock('@/app/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

describe('Webhooks API Route with Metrics', () => {
  beforeEach(() => {
    registry.resetMetrics();
    jest.clearAllMocks();
    resetRateLimitStore();
  });

  afterEach(() => {
    resetRateLimitStore();
  });

  it('GET /api/webhooks returns prometheus metrics', async () => {
    // Increment a metric to ensure it appears in the output
    webhookCounter.inc({ status: '200', event_type: 'test_event' });

    const response = await GET(new Request('http://localhost/api/webhooks'));
    
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    
    const text = await response.text();
    expect(text).toContain('webhook_requests_total');
    expect(text).toContain('status="200"');
    expect(text).toContain('event_type="test_event"');
  });

  it('POST /api/webhooks records metrics on successful request', async () => {
    const req = new NextRequest('http://localhost/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({ eventType: 'test_event' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const metrics = await registry.metrics();
    expect(metrics).toContain('webhook_requests_total{status="200",event_type="test_event"} 1');
    expect(metrics).toContain('webhook_request_duration_seconds_count{status="200",event_type="test_event"} 1');
  });

  it('POST /api/webhooks records metrics on 400 error', async () => {
    const req = new NextRequest('http://localhost/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(req);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe('INVALID_INPUT');

    const metrics = await registry.metrics();
    expect(metrics).toContain('webhook_requests_total{status="400",event_type="unknown"} 1');
    expect(metrics).toContain('webhook_request_duration_seconds_count{status="400",event_type="unknown"} 1');
  });
});
