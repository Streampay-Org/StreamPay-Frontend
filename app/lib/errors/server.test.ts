/** @jest-environment node */
import { errorResponse } from './server';
import { withCorrelationContext } from '@/app/lib/logger';

describe('error responses', () => {
  it('preserves the request ID from the active correlation context', async () => {
    const response = await withCorrelationContext(
      { request_id: 'req_forwarded', correlation_id: 'req_forwarded' },
      async () => errorResponse('BAD_REQUEST', 'Invalid input', 400),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid input', request_id: 'req_forwarded' },
    });
  });

  it('creates a fallback ID when no request context is available', async () => {
    const response = await errorResponse('INTERNAL_ERROR', 'Try again');
    expect(response.status).toBe(500);
    expect((await response.json()).error.request_id).toMatch(/^req_/);
  });
});
