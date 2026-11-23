import { NextRequest, NextResponse } from 'next/server';
import { extractCorrelationContext, correlationContext, logger, updateCorrelationContext } from '@/app/lib/logger';

// Internal headers that should not be exposed to external clients
const INTERNAL_HEADERS = [
  'x-internal-auth',
  'x-service-token',
  'x-correlation-id-internal',
];

/**
 * Converts an unknown error into a plain object so safe-json serialization
 * preserves the error context (Error objects lose their non-enumerable props).
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined,
    };
  }
  return { value: String(error) };
}

/**
 * Middleware to extract and set correlation context from request headers
 * This should be called at the beginning of each API route handler
 */
export async function withCorrelationMiddleware(
  request: NextRequest,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const headers = request.headers;
  
  // Extract correlation context from headers
  const context = extractCorrelationContext(headers);
  
  // Log incoming request
  logger.info('Incoming request', {
    method: request.method,
    url: request.url,
    user_agent: headers.get('user-agent'),
  });
  
  // Execute handler with correlation context
  return correlationContext.run(context, async () => {
    try {
      const response = await handler();
      
      // Strip internal headers from response
      const responseHeaders = new Headers(response.headers);
      INTERNAL_HEADERS.forEach(header => {
        responseHeaders.delete(header);
      });
      
      // Add correlation headers to response for internal tracing
      responseHeaders.set('x-request-id', context.request_id);
      responseHeaders.set('x-correlation-id', context.correlation_id);
      if (context.traceparent) {
        responseHeaders.set('traceparent', context.traceparent);
      }
      
      // Log response
      logger.info('Request completed', {
        status: response.status,
        method: request.method,
        url: request.url,
      });
      
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      // Log the error with a serializable context so safe-json serialization
      // preserves the original error details (name, message, stack, cause).
      logger.error('Request failed', {
        error: serializeError(error),
        method: request.method,
        url: request.url,
        request_id: context.request_id,
        correlation_id: context.correlation_id,
      });
      throw error;
    }
  });
}

/**
 * Helper to add stream-specific context to correlation
 */
export function withStreamContext(streamId: string) {
  updateCorrelationContext({ stream_id: streamId });
}

/**
 * Helper to add job-specific context to correlation
 */
export function withJobContext(jobId: string, queueName?: string) {
  updateCorrelationContext({ job_id: jobId, queue_name: queueName });
}

/**
 * Helper to add Stellar transaction context
 */
export function withStellarContext(txHash: string) {
  updateCorrelationContext({ stellar_tx_hash: txHash });
}

/**
 * Helper to add webhook context
 */
export function withWebhookContext(webhookId: string) {
  updateCorrelationContext({ webhook_id: webhookId });
}

/**
 * Helper to add retry context
 */
export function withRetryContext(retryCount: number) {
  updateCorrelationContext({ retry_count: retryCount });
}