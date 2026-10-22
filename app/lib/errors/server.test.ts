/** @jest-environment node */
import { withCorrelationContext } from '@/app/lib/logger';
import { errorResponse } from './server';

describe('request ID resolution in error responses', () => {
  it('preserves the request ID from correlation context', async () => {
    await withCorrelationContext({ request_id: 'req_forwarded' }, async () => {
      const response = errorResponse('BAD_REQUEST', 'Invalid input', 400);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Invalid input', request_id: 'req_forwarded' },
      });
    });
  });

  it('preserves the request ID from explicit options', async () => {
    const response = errorResponse('BAD_REQUEST', 'Invalid input', 400, undefined, {
      requestId: 'req_explicit',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid input', request_id: 'req_explicit' },
    });
  });

  it('creates a fallback ID when no request context is available', async () => {
    const response = errorResponse('INTERNAL_ERROR', 'Try again');
    expect(response.status).toBe(500);
    expect((await response.json()).error.request_id).toMatch(/^req_/);
  });
});
