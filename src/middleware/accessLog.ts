import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware to add structured access logging and correlation IDs to webhook routes.
 */
export function withAccessLog(handler: (req: NextRequest) => Promise<NextResponse> | NextResponse) {
  return async (req: NextRequest): Promise<NextResponse> => {
    // Extract or generate a correlation ID
    const correlationId = req.headers.get('x-correlation-id') || uuidv4();
    const startTime = Date.now();
    
    // Log incoming request
    console.log(JSON.stringify({
      level: 'info',
      message: 'Incoming webhook request',
      method: req.method,
      url: req.url,
      correlation_id: correlationId,
      timestamp: new Date().toISOString()
    }));

    try {
      const res = await handler(req);
      const duration = Date.now() - startTime;
      
      // Log successful response completion
      console.log(JSON.stringify({
        level: 'info',
        message: 'Webhook request completed',
        method: req.method,
        url: req.url,
        status: res.status,
        duration_ms: duration,
        correlation_id: correlationId,
        timestamp: new Date().toISOString()
      }));

      // Add correlation ID to the response headers
      res.headers.set('x-correlation-id', correlationId);
      return res;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log failure
      console.error(JSON.stringify({
        level: 'error',
        message: 'Webhook request failed',
        method: req.method,
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: duration,
        correlation_id: correlationId,
        timestamp: new Date().toISOString()
      }));

      // Standardized error envelope
      return NextResponse.json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred during webhook processing.'
        },
        correlation_id: correlationId
      }, { 
        status: 500, 
        headers: { 'x-correlation-id': correlationId } 
      });
    }
  };
}
