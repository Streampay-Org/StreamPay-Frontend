import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import {
  isTrustedInternalRequest,
  sanitizeCorrelationHeaders,
  withCorrelationMiddleware,
  withJobContext,
  withRetryContext,
  withStellarContext,
  withStreamContext,
  withWebhookContext,
} from './correlation-middleware';
import { getCorrelationContext, withCorrelationContext } from './logger';

const vi = jest;

describe('correlation-middleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps requests in correlation context and exposes correlation headers', async () => {
    const request = new NextRequest('http://localhost/api/streams', {
      method: 'GET',
    });

    const handler = vi.fn(async () => {
      const context = getCorrelationContext();
      expect(context?.request_id).toBeTruthy();
      expect(context?.correlation_id).toBeTruthy();
      return NextResponse.json({ ok: true });
    });

    const response = await withCorrelationMiddleware(request, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('strips internal headers from responses', async () => {
    const request = new NextRequest('http://localhost/api/streams', {
      method: 'GET',
    });

    const handler = vi.fn(async () =>
      new NextResponse(JSON.stringify({ ok: true }), {
        headers: {
          'x-internal-auth': 'secret',
          'x-service-token': 'token',
          'x-correlation-id-internal': 'internal-id',
        },
      }),
    );

    const response = await withCorrelationMiddleware(request, handler);

    expect(response.headers.get('x-internal-auth')).toBeNull();
    expect(response.headers.get('x-service-token')).toBeNull();
    expect(response.headers.get('x-correlation-id-internal')).toBeNull();
  });

  it('preserves traceparent for trusted requests', async () => {
    const request = new NextRequest('http://localhost/api/streams', {
      method: 'GET',
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });

    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const response = await withCorrelationMiddleware(request, handler);

    expect(response.headers.get('traceparent')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });

  it('returns true for localhost and loopback hosts', () => {
    expect(isTrustedInternalRequest(new NextRequest('http://localhost/api/streams', {
      headers: { host: 'localhost' },
    }))).toBe(true);
    expect(isTrustedInternalRequest(new NextRequest('http://127.0.0.1/api/streams', {
      headers: { host: '127.0.0.1' },
    }))).toBe(true);
  });

  it('returns false for external hosts when no trusted auth token is supplied', () => {
    const request = new NextRequest('https://api.example.com/streams', {
      headers: { host: 'api.example.com' },
    });

    expect(isTrustedInternalRequest(request)).toBe(false);
  });

  it('accepts a valid internal auth token for trusted requests', () => {
    process.env.INTERNAL_AUTH_TOKEN = 'valid-token';
    const request = new NextRequest('https://api.example.com/streams', {
      headers: {
        host: 'api.example.com',
        'x-internal-auth': 'valid-token',
      },
    });

    expect(isTrustedInternalRequest(request)).toBe(true);
    delete process.env.INTERNAL_AUTH_TOKEN;
  });

  it('does not trust external correlation IDs and generates fresh values', () => {
    const request = new NextRequest('https://api.example.com/streams', {
      headers: {
        'x-request-id': 'req-123',
        'x-correlation-id': 'corr-456',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });

    const result = sanitizeCorrelationHeaders(request, false);

    expect(result.requestId).not.toBe('req-123');
    expect(result.correlationId).not.toBe('corr-456');
    expect(result.traceparent).toBeUndefined();
  });

  it('keeps trusted correlation headers for trusted requests', () => {
    const request = new NextRequest('http://localhost/api/streams', {
      headers: {
        'x-request-id': 'req-123',
        'x-correlation-id': 'corr-456',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });

    const result = sanitizeCorrelationHeaders(request, true);

    expect(result.requestId).toBe('req-123');
    expect(result.correlationId).toBe('corr-456');
    expect(result.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });

  it('updates correlation context for stream, job, stellar, webhook, and retry metadata', async () => {
    await withCorrelationContext(
      { request_id: 'req-1', correlation_id: 'corr-1' },
      async () => {
        withStreamContext('stream-123');
        withJobContext('job-456', 'settlement-queue');
        withStellarContext('tx-hash-789');
        withWebhookContext('webhook-abc');
        withRetryContext(3);

        const context = getCorrelationContext();
        expect(context?.stream_id).toBe('stream-123');
        expect(context?.job_id).toBe('job-456');
        expect(context?.queue_name).toBe('settlement-queue');
        expect(context?.stellar_tx_hash).toBe('tx-hash-789');
        expect(context?.webhook_id).toBe('webhook-abc');
        expect(context?.retry_count).toBe(3);
      },
    );
  });
});
