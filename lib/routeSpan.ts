/**
 * lib/routeSpan.ts — SERVER spans for Next.js API routes.
 *
 * Wraps a route handler in a `SERVER` span and connects the span to the
 * structured logger through the AsyncLocalStorage correlation context.
 *
 * Inbound W3C `traceparent` headers are only honoured for requests that pass
 * `verifyInternalServiceRequest()`. Public requests always start a new trace,
 * so external callers cannot splice their own trace IDs into ours.
 */

import {
  correlationContext,
  extractCorrelationContext,
  type CorrelationContext,
} from '@/app/lib/logger';
import { verifyInternalServiceRequest } from '@/app/lib/internal-service-auth';
import {
  extractTraceHeaders,
  redactAttributes,
  tracer,
  type TraceContext,
} from '@/lib/otel';

type RouteHandler = (request?: Request) => Promise<Response> | Response;

function newCorrelationContext(request?: Request): CorrelationContext {
  if (!request || typeof extractCorrelationContext !== 'function') {
    return {
      request_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
    };
  }

  const context = extractCorrelationContext(request.headers) ?? {
    request_id: crypto.randomUUID(),
    correlation_id: crypto.randomUUID(),
  };
  // Never trust an inbound traceparent from the generic extractor; the span
  // resolves the parent separately, and only after signature verification.
  context.traceparent = undefined;
  return context;
}

/**
 * Run the handler inside the correlation ALS when the logger module exposes a
 * real implementation. Some unit tests mock the logger; falling back to a
 * direct call keeps tracing functional without an ALS store.
 */
function runWithCorrelation<T>(
  context: CorrelationContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (correlationContext && typeof correlationContext.run === 'function') {
    const result = correlationContext.run(context, fn);
    if (result !== undefined) return result;
  }
  return fn();
}

/**
 * Returns the inbound trace context only when the request is an authenticated
 * internal service request. Any failure (including a missing/invalid config)
 * is treated as untrusted.
 */
async function trustedParent(request?: Request): Promise<TraceContext | null> {
  if (!request) return null;
  if (!request.headers.get('traceparent')) return null;

  try {
    const verification = await verifyInternalServiceRequest(request);
    if (!verification.ok) return null;
    return extractTraceHeaders(request.headers);
  } catch {
    return null;
  }
}

function setTraceparentHeader(response: Response, traceparent: string): Response {
  try {
    response.headers.set('traceparent', traceparent);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set('traceparent', traceparent);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Wraps a route handler in a `SERVER` span.
 *
 * @param routeTemplate - Route template (e.g. `/api/activity`), never the raw
 *   request path, so span cardinality stays bounded.
 * @param handler       - The route handler to execute inside the span.
 */
export function withRouteSpan(
  routeTemplate: string,
  handler: RouteHandler,
): (request?: Request) => Promise<Response> {
  return async function routeSpanHandler(request?: Request): Promise<Response> {
    const method = request?.method ?? 'GET';
    const parent = await trustedParent(request);
    const correlation = newCorrelationContext(request);

    return runWithCorrelation(correlation, async () => {
      const span = tracer.startSpan(`${method} ${routeTemplate}`, {
        kind: 'SERVER',
        parent: parent ?? null,
        attributes: redactAttributes({
          'http.method': method,
          'http.route': routeTemplate,
        }),
      });

      // Expose span identity to the structured logger for the whole request.
      correlation.trace_id = span.context.traceId;
      correlation.span_id = span.context.spanId;
      correlation.traceparent = span.context.traceparent;

      try {
        const response = await handler(request);
        span.setAttribute('http.status_code', response.status);
        span.setStatus(response.status >= 500 ? 'ERROR' : 'OK');
        return setTraceparentHeader(response, span.context.traceparent);
      } catch (error) {
        span.setAttribute('http.status_code', 500);
        span.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    });
  };
}
