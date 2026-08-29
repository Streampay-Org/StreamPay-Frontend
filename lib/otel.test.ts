/**
 * Tests for `lib/otel.ts` — OpenTelemetry auto-instrumentation
 *
 * Covers: ID generation, traceparent format/parse, Span lifecycle,
 * withSpan helper, OTLP export, propagation helpers, singleton.
 */

// ── Stable module-level store shared across all tests ────────────────────────
// We define this as a plain object so jest.mock's factory (which is hoisted)
// can safely return it via a closure captured at module load time.

// Jest hoists jest.mock() above imports, but NOT above variable declarations
// in the same file when using CommonJS transforms. To be safe we keep the
// store and getStore mock *inside* the factory and expose them via the module.

jest.mock('../app/lib/logger', () => {
  const store: Record<string, unknown> = {};
  const getStore = jest.fn(() => store);
  return {
    correlationContext: { getStore, run: jest.fn((_: unknown, fn: () => unknown) => fn()) },
    __store: store,
    __getStore: getStore,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getCorrelationContext: jest.fn(() => store),
    withCorrelationContext: jest.fn(),
    extractCorrelationContext: jest.fn(),
  };
});

import * as LoggerMock from '../app/lib/logger';

// Typed accessors into the internal mock state
const _store  = (LoggerMock as unknown as { __store: Record<string, unknown> }).__store;
const _getStore = (LoggerMock as unknown as { __getStore: jest.Mock }).__getStore;

// ── Mock fetch ────────────────────────────────────────────────────────────────
const mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
global.fetch = mockFetch as unknown as typeof fetch;

// ── Import under test ─────────────────────────────────────────────────────────
import {
  randomHex,
  generateTraceId,
  generateSpanId,
  formatTraceparent,
  parseTraceparent,
  otlpHttpExport,
  Tracer,
  tracer,
  injectTraceHeaders,
  extractTraceHeaders,
  isTelemetryConsented,
  setTelemetryConsent,
  resetTelemetryConsent,
  redactAttributes,
  redactSpanRecord,
  type TraceContext,
  type SpanRecord,
} from './otel';

// ── Helper ────────────────────────────────────────────────────────────────────
function makeCtx(overrides: Partial<TraceContext> = {}): TraceContext {
  const traceId    = overrides.traceId    ?? '0'.repeat(32);
  const spanId     = overrides.spanId     ?? 'a'.repeat(16);
  const traceFlags = overrides.traceFlags ?? '01';
  return {
    traceId, spanId, traceFlags,
    traceparent: overrides.traceparent ?? `00-${traceId}-${spanId}-${traceFlags}`,
  };
}

function freshTracer(): [Tracer, SpanRecord[]] {
  const records: SpanRecord[] = [];
  return [new Tracer(r => records.push(r)), records];
}

// ── randomHex ─────────────────────────────────────────────────────────────────

describe('randomHex', () => {
  it('returns a string of 2x the requested byte length', () => {
    expect(randomHex(8)).toHaveLength(16);
    expect(randomHex(16)).toHaveLength(32);
  });
  it('returns only lowercase hex', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]+$/);
  });
  it('returns different values on successive calls', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

// ── generateTraceId / generateSpanId ─────────────────────────────────────────

describe('generateTraceId', () => {
  it('returns a 32-char lowercase hex string', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
  it('generates unique IDs', () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
  });
});

describe('generateSpanId', () => {
  it('returns a 16-char lowercase hex string', () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it('generates unique IDs', () => {
    expect(generateSpanId()).not.toBe(generateSpanId());
  });
});

// ── formatTraceparent ─────────────────────────────────────────────────────────

describe('formatTraceparent', () => {
  const traceId = 'a'.repeat(32);
  const spanId  = 'b'.repeat(16);

  it('formats W3C traceparent with default sampled flag', () => {
    expect(formatTraceparent(traceId, spanId)).toBe(`00-${traceId}-${spanId}-01`);
  });
  it('respects an explicit traceFlags value', () => {
    expect(formatTraceparent(traceId, spanId, '00')).toBe(`00-${traceId}-${spanId}-00`);
  });
  it('starts with version byte 00', () => {
    expect(formatTraceparent(traceId, spanId)).toMatch(/^00-/);
  });
});

// ── parseTraceparent ──────────────────────────────────────────────────────────

describe('parseTraceparent', () => {
  const traceId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const spanId  = '1234567890abcdef';
  const valid   = `00-${traceId}-${spanId}-01`;

  it('parses a valid traceparent', () => {
    const ctx = parseTraceparent(valid);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe(traceId);
    expect(ctx!.spanId).toBe(spanId);
    expect(ctx!.traceFlags).toBe('01');
    expect(ctx!.traceparent).toBe(valid);
  });
  it('returns null for null', ()      => expect(parseTraceparent(null)).toBeNull());
  it('returns null for undefined', () => expect(parseTraceparent(undefined)).toBeNull());
  it('returns null for empty string', () => expect(parseTraceparent('')).toBeNull());
  it('returns null for wrong segment count', () => {
    expect(parseTraceparent('00-abc-def')).toBeNull();
    expect(parseTraceparent('00-abc-def-01-extra')).toBeNull();
  });
  it('returns null for unknown version', () => {
    expect(parseTraceparent(`ff-${traceId}-${spanId}-01`)).toBeNull();
  });
  it('returns null for short traceId', () => {
    expect(parseTraceparent(`00-short-${spanId}-01`)).toBeNull();
  });
  it('returns null for short spanId', () => {
    expect(parseTraceparent(`00-${traceId}-short-01`)).toBeNull();
  });
  it('returns null for non-hex traceId', () => {
    expect(parseTraceparent(`00-${'z'.repeat(32)}-${spanId}-01`)).toBeNull();
  });
  it('returns null for non-hex spanId', () => {
    expect(parseTraceparent(`00-${traceId}-${'z'.repeat(16)}-01`)).toBeNull();
  });
  it('round-trips with formatTraceparent', () => {
    const tp  = formatTraceparent(traceId, spanId);
    const ctx = parseTraceparent(tp);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe(traceId);
    expect(ctx!.spanId).toBe(spanId);
  });
});

// ── Span lifecycle ────────────────────────────────────────────────────────────

describe('Span lifecycle', () => {
  beforeEach(() => {
    delete _store.traceparent;
    _getStore.mockReturnValue(_store);
    jest.clearAllMocks();
  });

  it('generates valid traceId and spanId', () => {
    const [t] = freshTracer();
    const span = t.startSpan('test');
    expect(span.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    span.end();
  });

  it('end() returns SpanRecord with correct name', () => {
    const [t] = freshTracer();
    expect(t.startSpan('my.span').end().name).toBe('my.span');
  });

  it('durationMs >= 0', () => {
    const [t] = freshTracer();
    expect(t.startSpan('dur').end().durationMs).toBeGreaterThanOrEqual(0);
  });

  it('end() is idempotent — exporter called only once', async () => {
    const exp = jest.fn();
    const span = new Tracer(exp).startSpan('idem');
    span.end(); span.end(); span.end();
    await Promise.resolve();
    expect(exp).toHaveBeenCalledTimes(1);
  });

  it('setAttribute stores values and is chainable', () => {
    const [t, recs] = freshTracer();
    const span = t.startSpan('attr');
    expect(span.setAttribute('k', 'v')).toBe(span);
    span.end();
    expect(recs[0].attributes['k']).toBe('v');
  });

  it('setAttributes sets multiple at once', () => {
    const [t, recs] = freshTracer();
    t.startSpan('multi').setAttributes({ a: 1, b: 'two' }).end();
    expect(recs[0].attributes).toMatchObject({ a: 1, b: 'two' });
  });

  it('silently drops attributes beyond 64', () => {
    const [t, recs] = freshTracer();
    const span = t.startSpan('overflow');
    for (let i = 0; i < 70; i++) span.setAttribute(`k${i}`, i);
    span.end();
    expect(Object.keys(recs[0].attributes).length).toBeLessThanOrEqual(64);
  });

  it('addEvent records name, timestamp, and attributes', () => {
    const before = Date.now();
    const [t, recs] = freshTracer();
    t.startSpan('evts').addEvent('click', { x: 1 }).end();
    expect(recs[0].events).toHaveLength(1);
    expect(recs[0].events[0].name).toBe('click');
    expect(recs[0].events[0].attributes['x']).toBe(1);
    expect(recs[0].events[0].timestamp).toBeGreaterThanOrEqual(before);
  });

  it('addEvent is chainable', () => {
    const [t] = freshTracer();
    const span = t.startSpan('ce');
    expect(span.addEvent('e')).toBe(span);
    span.end();
  });

  it('silently drops events beyond 128', () => {
    const [t, recs] = freshTracer();
    const span = t.startSpan('evtoverflow');
    for (let i = 0; i < 140; i++) span.addEvent(`e${i}`);
    span.end();
    expect(recs[0].events.length).toBeLessThanOrEqual(128);
  });

  it('setStatus sets status and message', () => {
    const [t, recs] = freshTracer();
    t.startSpan('st').setStatus('ERROR', 'oops').end();
    expect(recs[0].status).toBe('ERROR');
    expect(recs[0].statusMessage).toBe('oops');
  });

  it('default status is UNSET', () => {
    const [t, recs] = freshTracer();
    t.startSpan('unset').end();
    expect(recs[0].status).toBe('UNSET');
  });

  it('recordError sets ERROR + exception event', () => {
    const [t, recs] = freshTracer();
    const err = new Error('boom');
    t.startSpan('err').recordError(err).end();
    expect(recs[0].status).toBe('ERROR');
    expect(recs[0].statusMessage).toBe('boom');
    const exc = recs[0].events.find(e => e.name === 'exception');
    expect(exc).toBeDefined();
    expect(exc!.attributes['exception.message']).toBe('boom');
  });

  it('recordError handles non-Error values', () => {
    const [t, recs] = freshTracer();
    t.startSpan('s').recordError('raw error').end();
    expect(recs[0].status).toBe('ERROR');
  });

  it('span record includes a valid traceparent', () => {
    const [t, recs] = freshTracer();
    t.startSpan('tp').end();
    expect(recs[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('span context traceparent matches record traceparent', () => {
    const [t, recs] = freshTracer();
    const span = t.startSpan('match');
    span.end();
    expect(span.context.traceparent).toBe(recs[0].traceparent);
  });

  it('span record includes service name', () => {
    const [t, recs] = freshTracer();
    t.startSpan('svc').end();
    expect(typeof recs[0].service).toBe('string');
    expect(recs[0].service.length).toBeGreaterThan(0);
  });
});

// ── Parent context ────────────────────────────────────────────────────────────

describe('parent context', () => {
  beforeEach(() => {
    delete _store.traceparent;
    _getStore.mockReturnValue(_store);
  });

  it('child inherits traceId from explicit parent', () => {
    const [t, recs] = freshTracer();
    const parent = makeCtx({ traceId: 'f'.repeat(32), spanId: '1'.repeat(16) });
    t.startSpan('child', { parent }).end();
    expect(recs[0].traceId).toBe('f'.repeat(32));
    expect(recs[0].parentSpanId).toBe('1'.repeat(16));
  });

  it('child generates new spanId', () => {
    const [t, recs] = freshTracer();
    const parent = makeCtx({ spanId: '1'.repeat(16) });
    t.startSpan('child', { parent }).end();
    expect(recs[0].spanId).not.toBe('1'.repeat(16));
  });

  it('uses ambient correlation traceparent when no explicit parent', () => {
    const traceId = 'a'.repeat(32);
    const spanId  = 'b'.repeat(16);
    _store.traceparent = `00-${traceId}-${spanId}-01`;
    _getStore.mockReturnValue(_store);

    const [t, recs] = freshTracer();
    t.startSpan('ambient').end();
    expect(recs[0].traceId).toBe(traceId);
    expect(recs[0].parentSpanId).toBe(spanId);
  });

  it('explicit parent=null forces a new root trace', () => {
    _store.traceparent = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`;
    _getStore.mockReturnValue(_store);

    const [t, recs] = freshTracer();
    t.startSpan('root', { parent: null }).end();
    expect(recs[0].traceId).not.toBe('c'.repeat(32));
    expect(recs[0].parentSpanId).toBeUndefined();
  });

  it('root span has no parentSpanId', () => {
    _getStore.mockReturnValue({ traceparent: undefined });
    const [t, recs] = freshTracer();
    t.startSpan('root').end();
    expect(recs[0].parentSpanId).toBeUndefined();
  });
});

// ── SpanKind ──────────────────────────────────────────────────────────────────

describe('SpanKind', () => {
  it.each(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'] as const)(
    'records kind %s',
    async (kind) => {
      const [t, recs] = freshTracer();
      _getStore.mockReturnValue({});
      t.startSpan('k', { kind }).end();
      await Promise.resolve();
      expect(recs[0].kind).toBe(kind);
    }
  );

  it('defaults to INTERNAL', async () => {
    _getStore.mockReturnValue({});
    const [t, recs] = freshTracer();
    t.startSpan('def').end();
    await Promise.resolve();
    expect(recs[0].kind).toBe('INTERNAL');
  });
});

// ── withSpan ──────────────────────────────────────────────────────────────────

describe('withSpan', () => {
  beforeEach(() => {
    delete _store.traceparent;
    _getStore.mockReturnValue(_store);
  });

  it('returns callback value', async () => {
    const [t] = freshTracer();
    expect(await t.withSpan('add', async () => 42)).toBe(42);
  });

  it('sets OK on success', async () => {
    const [t, recs] = freshTracer();
    await t.withSpan('ok', async () => {});
    await Promise.resolve();
    expect(recs[0].status).toBe('OK');
  });

  it('sets ERROR and re-throws on failure', async () => {
    const [t, recs] = freshTracer();
    await expect(
      t.withSpan('fail', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    await Promise.resolve();
    expect(recs[0].status).toBe('ERROR');
  });

  it('always ends the span even when callback throws', async () => {
    const [t, recs] = freshTracer();
    try { await t.withSpan('throw', async () => { throw new Error(); }); } catch {}
    await Promise.resolve();
    expect(recs).toHaveLength(1);
    expect(recs[0].endTime).toBeGreaterThan(0);
  });

  it('passes the span to the callback', async () => {
    const [t, recs] = freshTracer();
    let sid = '';
    await t.withSpan('pass', async span => { sid = span.context.spanId; });
    await Promise.resolve();
    expect(recs[0].spanId).toBe(sid);
  });

  it('attributes set in callback appear in record', async () => {
    const [t, recs] = freshTracer();
    await t.withSpan('attrs', async span => { span.setAttribute('x', 1); });
    await Promise.resolve();
    expect(recs[0].attributes['x']).toBe(1);
  });

  it('respects initial attributes from options', async () => {
    const [t, recs] = freshTracer();
    await t.withSpan('init', async () => {}, { attributes: { op: 'read' } });
    await Promise.resolve();
    expect(recs[0].attributes['op']).toBe('read');
  });
});

// ── Correlation context propagation ──────────────────────────────────────────

describe('correlation context propagation', () => {
  it('injects traceparent into the correlation store', () => {
    const store: { traceparent?: string } = {};
    _getStore.mockReturnValue(store);
    const [t] = freshTracer();
    t.startSpan('inject');
    expect(store.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('does not throw when correlation store is null', () => {
    _getStore.mockReturnValue(null);
    const [t] = freshTracer();
    expect(() => t.startSpan('null.store').end()).not.toThrow();
  });
});

// ── OTLP export ───────────────────────────────────────────────────────────────

describe('otlpHttpExport', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    mockFetch.mockClear();
    resetTelemetryConsent();
  });

  afterEach(() => { process.env = OLD_ENV; resetTelemetryConsent(); });

  it('does nothing when OTLP endpoint is not set', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const span: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'x', kind: 'INTERNAL', startTime: 1000, endTime: 1050,
      durationMs: 50, status: 'OK', attributes: {}, events: [],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    await otlpHttpExport(span);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT POST when consent has not been granted, even if endpoint is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    jest.resetModules();
    const { otlpHttpExport: fresh } = await import('./otel');
    setTelemetryConsent(false);
    const span: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'pay', kind: 'SERVER', startTime: 1000, endTime: 1050,
      durationMs: 50, status: 'OK', attributes: { email: 'a@b.com', k: 'v' }, events: [],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    await fresh(span);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs when endpoint is set AND consent is granted', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    jest.resetModules();
    const { otlpHttpExport: fresh, setTelemetryConsent: grant } = await import('./otel');
    grant(true);
    const span: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'pay', kind: 'SERVER', startTime: 1000, endTime: 1050,
      durationMs: 50, status: 'OK', attributes: { k: 'v' }, events: [],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    await fresh(span);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://otel:4318/v1/traces',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toHaveProperty('resourceSpans');
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('pay');
  });

  it('redacts sensitive attributes before export when consent is granted', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    jest.resetModules();
    const { otlpHttpExport: fresh, setTelemetryConsent: grant } = await import('./otel');
    grant(true);
    const span: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'pay', kind: 'SERVER', startTime: 1000, endTime: 1050,
      durationMs: 50, status: 'OK',
      attributes: {
        email: 'user@corp.io',
        recipient: 'GABCDEF0000000000000000000000000000000000000000000000000000001234',
        safe_metric: 42,
      },
      events: [{ name: 'exception', timestamp: 1001, attributes: { 'exception.message': 'bad for user@corp.io' } }],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    await fresh(span);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const outAttrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const byKey = Object.fromEntries(outAttrs.map((a: any) => [a.key, a.value.stringValue]));
    expect(byKey.email).toBe('[REDACTED]');
    expect(byKey.recipient).toBe('[REDACTED]');
    expect(byKey.safe_metric).toBe(42);
    const outEventAttrs = body.resourceSpans[0].scopeSpans[0].spans[0].events[0].attributes;
    const evtByKey = Object.fromEntries(outEventAttrs.map((a: any) => [a.key, a.value.stringValue]));
    expect(evtByKey['exception.message']).toBe('[REDACTED]');
  });

  it('never throws even when fetch rejects', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://bad';
    jest.resetModules();
    const { otlpHttpExport: fresh, setTelemetryConsent: grant } = await import('./otel');
    grant(true);
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const span: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'x', kind: 'INTERNAL', startTime: 0, endTime: 0,
      durationMs: 0, status: 'UNSET', attributes: {}, events: [],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    await expect(fresh(span)).resolves.toBeUndefined();
  });

  it('does not mutate the original span record (safe for retries/concurrency)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    jest.resetModules();
    const { otlpHttpExport: fresh, setTelemetryConsent: grant } = await import('./otel');
    grant(true);
    const original: SpanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      name: 'pay', kind: 'SERVER', startTime: 1000, endTime: 1050,
      durationMs: 50, status: 'OK', attributes: { email: 'a@b.com' }, events: [],
      service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    };
    const snapshot = JSON.stringify(original);
    await fresh(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

// ── Consent API ───────────────────────────────────────────────────────────────

describe('telemetry consent API', () => {
  const OLD_ENV = process.env;
  beforeEach(() => { process.env = { ...OLD_ENV }; jest.resetModules(); });
  afterEach(() => { process.env = OLD_ENV; });

  it('defaults to denied (least privilege) when env is unset', async () => {
    delete process.env.STREAMPAY_TELEMETRY_CONSENT;
    const { isTelemetryConsented } = await import('./otel');
    expect(isTelemetryConsented()).toBe(false);
  });

  it('honors env opt-in (STREAMPAY_TELEMETRY_CONSENT=true)', async () => {
    process.env.STREAMPAY_TELEMETRY_CONSENT = 'true';
    const { isTelemetryConsented } = await import('./otel');
    expect(isTelemetryConsented()).toBe(true);
  });

  it('runtime set/clear toggles consent and reset restores default', async () => {
    const mod = await import('./otel');
    const envWas = mod.isTelemetryConsented();
    mod.setTelemetryConsent(true);
    expect(mod.isTelemetryConsented()).toBe(true);
    mod.setTelemetryConsent(false);
    expect(mod.isTelemetryConsented()).toBe(false);
    mod.resetTelemetryConsent();
    expect(mod.isTelemetryConsented()).toBe(envWas);
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

describe('redactAttributes', () => {
  it('masks sensitive keys regardless of value', () => {
    const out = redactAttributes({ email: 'keep@me.io', token: 'abc', label: 'x' });
    expect(out.email).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.label).toBe('[REDACTED]');
  });

  it('masks PII-shaped values even on non-sensitive keys', () => {
    const out = redactAttributes({ actor: 'user@corp.io', account: 'GABCDEF0000000000000000000000000000000000000000000000000000001234' });
    expect(out.actor).toBe('[REDACTED]');
    expect(out.account).toBe('[REDACTED]');
  });

  it('preserves non-sensitive data verbatim', () => {
    const out = redactAttributes({ duration_ms: 12, ok: true, path: '/api/x' });
    expect(out).toEqual({ duration_ms: 12, ok: true, path: '/api/x' });
  });

  it('redacts PII within array attribute values', () => {
    const out = redactAttributes({ recipients: ['user@corp.io', 'GABCDEF0000000000000000000000000000000000000000000000000000001234', 'pub'] });
    expect(out.recipients).toEqual(['[REDACTED]', '[REDACTED]', 'pub']);
  });

  it('returns empty object for null/undefined/non-object input', () => {
    expect(redactAttributes(null)).toEqual({});
    expect(redactAttributes(undefined)).toEqual({});
    expect(redactAttributes('oops' as any)).toEqual({});
  });

  it('is pure and never mutates the input', () => {
    const input = { email: 'a@b.com', ok: 1 };
    const snapshot = JSON.stringify(input);
    redactAttributes(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('redactSpanRecord', () => {
  const base: SpanRecord = {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
    name: 's', kind: 'INTERNAL', startTime: 1, endTime: 2, durationMs: 1,
    status: 'OK', attributes: { email: 'a@b.com', ok: 1 },
    events: [{ name: 'e', timestamp: 1, attributes: { memo: 'secret', n: 2 } }],
    service: 'svc', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
  };

  it('redacts attributes and event attributes', () => {
    const out = redactSpanRecord(base);
    expect(out.attributes.email).toBe('[REDACTED]');
    expect(out.attributes.ok).toBe(1);
    expect(out.events[0].attributes.memo).toBe('[REDACTED]');
    expect(out.events[0].attributes.n).toBe(2);
  });

  it('does not mutate the original record (concurrent/retry-safe)', () => {
    const snapshot = JSON.stringify(base);
    redactSpanRecord(base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('preserves structural fields (trace/status/service)', () => {
    const out = redactSpanRecord(base);
    expect(out.traceId).toBe(base.traceId);
    expect(out.status).toBe(base.status);
    expect(out.service).toBe(base.service);
  });
});

// ── Propagation helpers ───────────────────────────────────────────────────────

describe('injectTraceHeaders', () => {
  it('sets the traceparent header', () => {
    const h = new Headers();
    const ctx = makeCtx();
    injectTraceHeaders(h, ctx);
    expect(h.get('traceparent')).toBe(ctx.traceparent);
  });

  it('overwrites an existing traceparent header', () => {
    const h = new Headers({ traceparent: 'old' });
    injectTraceHeaders(h, makeCtx({ traceId: 'f'.repeat(32), spanId: 'e'.repeat(16) }));
    expect(h.get('traceparent')).not.toBe('old');
  });
});

describe('extractTraceHeaders', () => {
  const traceId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const spanId  = '1234567890abcdef';

  it('returns TraceContext for a valid header', () => {
    const h = new Headers({ traceparent: `00-${traceId}-${spanId}-01` });
    const ctx = extractTraceHeaders(h);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe(traceId);
    expect(ctx!.spanId).toBe(spanId);
  });

  it('returns null when header is absent', () => {
    expect(extractTraceHeaders(new Headers())).toBeNull();
  });

  it('returns null for malformed header', () => {
    expect(extractTraceHeaders(new Headers({ traceparent: 'bad' }))).toBeNull();
  });

  it('round-trips with injectTraceHeaders', () => {
    const ctx = makeCtx({ traceId: 'deadbeef'.repeat(4), spanId: 'cafebabe'.repeat(2) });
    const h = new Headers();
    injectTraceHeaders(h, ctx);
    const out = extractTraceHeaders(h);
    expect(out!.traceId).toBe(ctx.traceId);
    expect(out!.spanId).toBe(ctx.spanId);
  });
});

// ── Singleton ─────────────────────────────────────────────────────────────────

describe('tracer singleton', () => {
  it('is an instance of Tracer', () => {
    expect(tracer).toBeInstanceOf(Tracer);
  });

  it('can start and end a span without throwing', () => {
    _getStore.mockReturnValue({});
    expect(() => tracer.startSpan('singleton').end()).not.toThrow();
  });
});
