/** @jest-environment node */

/**
 * Test plan rows 3–9 for `withRouteSpan`.
 */

jest.mock('@/app/lib/internal-service-auth', () => ({
  verifyInternalServiceRequest: jest.fn(),
}));

import { verifyInternalServiceRequest } from '@/app/lib/internal-service-auth';
import { logger } from '@/app/lib/logger';
import { withRouteSpan } from './routeSpan';
import { tracer, type SpanRecord } from './otel';

const verifyMock = verifyInternalServiceRequest as jest.MockedFunction<
  typeof verifyInternalServiceRequest
>;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const PARENT_TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
global.fetch = fetchMock as unknown as typeof fetch;

function captureSpans(): SpanRecord[] {
  const records: SpanRecord[] = [];
  const original = tracer.startSpan.bind(tracer);

  jest.spyOn(tracer, 'startSpan').mockImplementation((name, options) => {
    const span = original(name, options);
    const end = span.end.bind(span);
    span.end = () => {
      const record = end();
      records.push(record);
      return record;
    };
    return span;
  });

  return records;
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.example.com${path}`, { headers });
}

describe('withRouteSpan', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({
      ok: false,
      code: 'MISSING_SIGNATURE',
      message: 'not trusted',
      status: 401,
    });
    fetchMock.mockClear();
  });

  it('emits one SERVER span with the route template and status code', async () => {
    const records = captureSpans();

    const handler = jest.fn(async () => new Response('ok', { status: 200 }));
    const response = await withRouteSpan('/api/activity', handler)(
      request('/api/activity?limit=5'),
    );

    expect(response.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('SERVER');
    expect(records[0].name).toBe('GET /api/activity');
    expect(records[0].attributes['http.method']).toBe('GET');
    expect(records[0].attributes['http.route']).toBe('/api/activity');
    expect(records[0].attributes['http.status_code']).toBe(200);
    expect(records[0].status).toBe('OK');
    expect(response.headers.get('traceparent')).toBe(records[0].traceparent);
  });

  it('records exceptions, marks the span ERROR, and re-throws', async () => {
    const records = captureSpans();
    const handler = async () => {
      throw new Error('handler failed');
    };

    await expect(
      withRouteSpan('/api/activity', handler)(request('/api/activity')),
    ).rejects.toThrow('handler failed');

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('ERROR');
    expect(records[0].statusMessage).toBe('handler failed');
    expect(records[0].attributes['http.status_code']).toBe(500);
    expect(records[0].events.some((event) => event.name === 'exception')).toBe(
      true,
    );
  });

  it('ignores an untrusted inbound traceparent and starts a new trace', async () => {
    const records = captureSpans();

    await withRouteSpan('/api/activity', async () => new Response('ok'))(
      request('/api/activity', { traceparent: PARENT_TRACEPARENT }),
    );

    expect(records[0].traceId).not.toBe(TRACE_ID);
    expect(records[0].parentSpanId).toBeUndefined();
  });

  it('honours traceparent from a verified internal service request', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      identity: {
        bodySha256: 'a'.repeat(64),
        keyId: 'worker',
        serviceName: 'worker',
        timestamp: new Date().toISOString(),
      },
    });
    const records = captureSpans();

    await withRouteSpan('/api/activity', async () => new Response('ok'))(
      request('/api/activity', { traceparent: PARENT_TRACEPARENT }),
    );

    expect(records[0].traceId).toBe(TRACE_ID);
    expect(records[0].parentSpanId).toBe(PARENT_SPAN_ID);
  });

  it('exposes trace_id and span_id to the structured logger', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const records = captureSpans();

    await withRouteSpan('/api/activity', async () => {
      logger.info('inside handler');
      return new Response('ok');
    })(request('/api/activity'));

    const line = logSpy.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('inside handler'));
    expect(line).toBeDefined();

    const entry = JSON.parse(line!);
    expect(entry.trace_id).toBe(records[0].traceId);
    expect(entry.span_id).toBe(records[0].spanId);
    expect(entry.traceparent).toBe(records[0].traceparent);
  });

  it('does not export when consent is off, even with an OTLP endpoint', async () => {
    const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    process.env.STREAMPAY_TELEMETRY_CONSENT = 'false';
    jest.resetModules();

    try {
      const fresh = await import('./otel');
      fresh.setTelemetryConsent(false);
      await fresh.otlpHttpExport({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'GET /api/activity',
        kind: 'SERVER',
        startTime: 1,
        endTime: 2,
        durationMs: 1,
        status: 'OK',
        attributes: {},
        events: [],
        service: 'streampay-frontend',
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
      }
      delete process.env.STREAMPAY_TELEMETRY_CONSENT;
    }
  });

  it('never trusts a Host: localhost request on its own', async () => {
    const records = captureSpans();

    await withRouteSpan('/api/activity', async () => new Response('ok'))(
      request('/api/activity', {
        host: 'localhost',
        traceparent: PARENT_TRACEPARENT,
      }),
    );

    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(records[0].traceId).not.toBe(TRACE_ID);
    expect(records[0].parentSpanId).toBeUndefined();
  });
});
