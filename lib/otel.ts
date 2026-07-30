/**
 * lib/otel.ts — OpenTelemetry auto-instrumentation for StreamPay
 *
 * Implements a lightweight, zero-external-dependency OTel-compatible tracing
 * layer that:
 *
 *  • Generates W3C-compliant traceparent / tracestate values
 *  • Propagates trace context via the existing AsyncLocalStorage correlation
 *    store in app/lib/logger.ts
 *  • Records structured spans with timing, attributes, and status
 *  • Exports spans as OTLP-compatible JSON to an HTTP collector endpoint
 *    (or a no-op if OTEL_EXPORTER_OTLP_ENDPOINT is not set)
 *  • Provides a higher-order helper (`withSpan`) for automatic span
 *    lifecycle management around async operations
 *
 * Design decisions
 * ────────────────
 * No `@opentelemetry/*` npm packages are added. The W3C wire format for
 * traceparent is trivially reproducible in < 50 lines, and adding the full
 * OTel SDK would pull > 30 transitive dependencies into a Next.js edge
 * bundle. This module is a thin adapter that speaks the same wire format
 * and can be replaced by the official SDK later with no API changes.
 *
 * Usage
 * ─────
 *   import { tracer } from '@/lib/otel';
 *
 *   const result = await tracer.withSpan('payment.process', async span => {
 *     span.setAttribute('stream_id', streamId);
 *     const res = await processPayment(streamId);
 *     return res;
 *   });
 */

import { correlationContext } from '@/app/lib/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** OTel version byte for the W3C traceparent header. */
const TRACEPARENT_VERSION = '00';

/** Default service name; override with the SERVICE_NAME env variable. */
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'streampay-frontend';

/** OTLP HTTP endpoint; omit to disable export. */
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;

/** Maximum number of attributes per span (prevents unbounded growth). */
const MAX_ATTRIBUTES = 64;

/** Maximum number of events per span. */
const MAX_EVENTS = 128;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';
export type SpanKind  = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';

/** Immutable trace context propagated through async boundaries. */
export interface TraceContext {
  /** 128-bit hex trace ID (32 hex chars). */
  traceId: string;
  /** 64-bit hex span ID (16 hex chars). */
  spanId: string;
  /** W3C trace flags ('01' = sampled). */
  traceFlags: string;
  /** W3C traceparent header value. */
  traceparent: string;
}

/** A single attribute value. */
export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

/** An event recorded during a span's lifetime. */
export interface SpanEvent {
  name: string;
  timestamp: number; // Unix ms
  attributes: Record<string, AttributeValue>;
}

/** A completed, immutable span record ready for export. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;    // Unix ms
  endTime: number;      // Unix ms
  durationMs: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
  service: string;
  /** W3C traceparent for this span. */
  traceparent: string;
}

/** Mutable handle returned by `Tracer.startSpan`. */
export interface Span {
  /** The span's own context (use for child-span creation). */
  readonly context: TraceContext;
  /** Set a single attribute. Silently dropped beyond MAX_ATTRIBUTES. */
  setAttribute(key: string, value: AttributeValue): this;
  /** Set multiple attributes at once. */
  setAttributes(attrs: Record<string, AttributeValue>): this;
  /** Record an event with optional attributes. */
  addEvent(name: string, attrs?: Record<string, AttributeValue>): this;
  /** Mark the span as OK. */
  setStatus(status: SpanStatus, message?: string): this;
  /** Record an error and set status to ERROR. */
  recordError(error: unknown): this;
  /** End the span and schedule export. */
  end(): SpanRecord;
}

/** Function that receives and processes a completed span. */
export type SpanExporter = (span: SpanRecord) => void | Promise<void>;

// ── ID generation ─────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random hex string of the given byte length.
 * Uses `crypto.getRandomValues` (available in Node.js 15+ and all browsers).
 *
 * @param bytes - Number of random bytes (hex output is 2× this length)
 * @returns Lowercase hex string
 */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates a new 128-bit (32 hex char) trace ID.
 */
export function generateTraceId(): string {
  return randomHex(16);
}

/**
 * Generates a new 64-bit (16 hex char) span ID.
 */
export function generateSpanId(): string {
  return randomHex(8);
}

/**
 * Formats a W3C traceparent header value.
 *
 * @param traceId   - 32-char hex trace ID
 * @param spanId    - 16-char hex span ID
 * @param flags     - 2-char hex trace flags ('01' = sampled, '00' = not sampled)
 * @returns         Formatted traceparent string
 *
 * @example
 * formatTraceparent('abc...', 'def...', '01')
 * // → '00-abc...-def...-01'
 */
export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
}

/**
 * Parses a W3C traceparent header string into its components.
 * Returns `null` if the value is missing or malformed.
 *
 * @param traceparent - Raw header value
 * @returns Parsed TraceContext or null
 */
export function parseTraceparent(traceparent: string | null | undefined): TraceContext | null {
  if (!traceparent) return null;
  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, traceFlags] = parts;
  if (version !== TRACEPARENT_VERSION) return null;
  if (!traceId || traceId.length !== 32) return null;
  if (!spanId  || spanId.length  !== 16) return null;
  if (!traceFlags || traceFlags.length !== 2) return null;
  if (!/^[0-9a-f]+$/.test(traceId) || !/^[0-9a-f]+$/.test(spanId)) return null;
  return { traceId, spanId, traceFlags, traceparent };
}

// ── Span implementation ───────────────────────────────────────────────────────

class SpanImpl implements Span {
  readonly context: TraceContext;

  private readonly _name: string;
  private readonly _kind: SpanKind;
  private readonly _parentSpanId: string | undefined;
  private readonly _startTime: number;
  private readonly _attrs: Record<string, AttributeValue> = {};
  private readonly _events: SpanEvent[] = [];
  private _status: SpanStatus = 'UNSET';
  private _statusMessage: string | undefined;
  private _ended = false;
  private readonly _exporter: SpanExporter;

  constructor(
    name: string,
    context: TraceContext,
    parentSpanId: string | undefined,
    kind: SpanKind,
    exporter: SpanExporter,
  ) {
    this._name = name;
    this.context = context;
    this._parentSpanId = parentSpanId;
    this._kind = kind;
    this._startTime = Date.now();
    this._exporter = exporter;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (Object.keys(this._attrs).length < MAX_ATTRIBUTES) {
      this._attrs[key] = value;
    }
    return this;
  }

  setAttributes(attrs: Record<string, AttributeValue>): this {
    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
    return this;
  }

  addEvent(name: string, attrs: Record<string, AttributeValue> = {}): this {
    if (this._events.length < MAX_EVENTS) {
      this._events.push({ name, timestamp: Date.now(), attributes: attrs });
    }
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this._status = status;
    this._statusMessage = message;
    return this;
  }

  recordError(error: unknown): this {
    const message = error instanceof Error ? error.message : String(error);
    const stack   = error instanceof Error ? error.stack  : undefined;
    this.addEvent('exception', {
      'exception.message': message,
      ...(stack ? { 'exception.stacktrace': stack } : {}),
    });
    this.setStatus('ERROR', message);
    return this;
  }

  end(): SpanRecord {
    if (this._ended) {
      // Idempotent — return the same record shape without re-exporting
      return this._buildRecord(this._startTime);
    }
    this._ended = true;
    const endTime = Date.now();
    const record = this._buildRecord(endTime);
    // Schedule export without blocking the caller
    Promise.resolve(this._exporter(record)).catch(() => {/* never throw */});
    return record;
  }

  private _buildRecord(endTime: number): SpanRecord {
    return {
      traceId: this.context.traceId,
      spanId:  this.context.spanId,
      ...(this._parentSpanId ? { parentSpanId: this._parentSpanId } : {}),
      name: this._name,
      kind: this._kind,
      startTime: this._startTime,
      endTime,
      durationMs: endTime - this._startTime,
      status: this._status,
      ...(this._statusMessage ? { statusMessage: this._statusMessage } : {}),
      attributes: { ...this._attrs },
      events: [...this._events],
      service: SERVICE_NAME,
      traceparent: this.context.traceparent,
    };
  }
}

// ── OTLP HTTP exporter ────────────────────────────────────────────────────────

/**
 * Builds an OTLP-compatible JSON payload for a single span and POSTs it to
 * the configured collector endpoint.
 *
 * This is a "fire and forget" export — errors are swallowed so tracing never
 * disrupts the request path.
 *
 * @param span - Completed span record
 */
export async function otlpHttpExport(span: SpanRecord): Promise<void> {
  if (!OTLP_ENDPOINT) return;

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: span.service } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'streampay/otel', version: '1.0.0' },
            spans: [
              {
                traceId:      span.traceId,
                spanId:       span.spanId,
                parentSpanId: span.parentSpanId ?? '',
                name:         span.name,
                kind:         spanKindToOtlp(span.kind),
                startTimeUnixNano: String(span.startTime * 1_000_000),
                endTimeUnixNano:   String(span.endTime   * 1_000_000),
                attributes: Object.entries(span.attributes).map(([k, v]) => ({
                  key:   k,
                  value: attributeValueToOtlp(v),
                })),
                events: span.events.map(e => ({
                  name:              e.name,
                  timeUnixNano:      String(e.timestamp * 1_000_000),
                  attributes: Object.entries(e.attributes).map(([k, v]) => ({
                    key: k, value: attributeValueToOtlp(v),
                  })),
                })),
                status: {
                  code:    spanStatusToOtlp(span.status),
                  message: span.statusMessage ?? '',
                },
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await fetch(`${OTLP_ENDPOINT}/v1/traces`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch {
    // Never throw from the exporter — tracing must not break the request path
  }
}

function spanKindToOtlp(kind: SpanKind): number {
  return { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 }[kind] ?? 1;
}

function spanStatusToOtlp(status: SpanStatus): number {
  return { UNSET: 0, OK: 1, ERROR: 2 }[status] ?? 0;
}

function attributeValueToOtlp(v: AttributeValue): Record<string, unknown> {
  if (typeof v === 'string')  return { stringValue:  v };
  if (typeof v === 'number')  return { doubleValue:  v };
  if (typeof v === 'boolean') return { boolValue:    v };
  if (Array.isArray(v)) {
    return {
      arrayValue: {
        values: (v as AttributeValue[]).map(el => attributeValueToOtlp(el as AttributeValue)),
      },
    };
  }
  return { stringValue: String(v) };
}

// ── Tracer ────────────────────────────────────────────────────────────────────

export interface StartSpanOptions {
  /** Parent trace context. Defaults to the ambient correlation context. */
  parent?: TraceContext | null;
  kind?: SpanKind;
  /** Initial attributes to set before the span body executes. */
  attributes?: Record<string, AttributeValue>;
}

/**
 * The main tracer object.  Obtain the singleton via `import { tracer } from
 * '@/lib/otel'`.
 */
export class Tracer {
  private readonly _exporter: SpanExporter;

  constructor(exporter: SpanExporter = otlpHttpExport) {
    this._exporter = exporter;
  }

  /**
   * Creates and starts a new span.
   *
   * The span is propagated into the AsyncLocalStorage correlation context so
   * that structured logs emitted inside the span automatically carry the
   * correct traceparent header.
   *
   * @param name    - Human-readable span name (e.g. `'payment.process'`)
   * @param options - Optional parent context, kind, and initial attributes
   * @returns       The mutable Span handle; call `.end()` when done
   */
  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const { kind = 'INTERNAL', attributes = {} } = options;

    // Resolve parent context from: explicit option → ambient correlation → null
    const parentCtx = options.parent !== undefined
      ? options.parent
      : this._ambientTraceContext();

    const traceId    = parentCtx?.traceId ?? generateTraceId();
    const spanId     = generateSpanId();
    const traceFlags = parentCtx?.traceFlags ?? '01';
    const traceparent = formatTraceparent(traceId, spanId, traceFlags);

    const ctx: TraceContext = { traceId, spanId, traceFlags, traceparent };

    const span = new SpanImpl(
      name,
      ctx,
      parentCtx?.spanId,
      kind,
      this._exporter,
    );

    span.setAttributes(attributes);

    // Propagate traceparent into the AsyncLocalStorage correlation context
    const correlation = correlationContext.getStore();
    if (correlation) {
      correlation.traceparent = traceparent;
    }

    return span;
  }

  /**
   * Wraps an async callback in a span, automatically ending it (with OK or
   * ERROR status) when the callback settles.
   *
   * @param name     - Span name
   * @param fn       - Async callback that receives the active Span
   * @param options  - Same options as `startSpan`
   * @returns        The callback's resolved value
   *
   * @example
   * const result = await tracer.withSpan('db.query', async span => {
   *   span.setAttribute('db.statement', sql);
   *   return db.query(sql);
   * });
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      if (span.context) {
        span.setStatus('OK');
      }
      return result;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Derives the current trace context from the AsyncLocalStorage correlation
   * store (set by `app/lib/logger.ts → extractCorrelationContext`).
   */
  private _ambientTraceContext(): TraceContext | null {
    const store = correlationContext.getStore();
    if (!store?.traceparent) return null;
    return parseTraceparent(store.traceparent);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/** Global tracer singleton. Import this in application code. */
export const tracer: Tracer = new Tracer(otlpHttpExport);

// ── Propagation helpers ───────────────────────────────────────────────────────

/**
 * Injects trace context headers into a `Headers` object for outbound HTTP
 * requests (W3C trace context propagation).
 *
 * @param headers - Mutable `Headers` instance to inject into
 * @param ctx     - Trace context to propagate
 */
export function injectTraceHeaders(headers: Headers, ctx: TraceContext): void {
  headers.set('traceparent', ctx.traceparent);
}

/**
 * Extracts a trace context from inbound HTTP request headers.
 * Returns `null` if no valid traceparent is present.
 *
 * @param headers - Request headers
 */
export function extractTraceHeaders(headers: Headers): TraceContext | null {
  return parseTraceparent(headers.get('traceparent'));
}
