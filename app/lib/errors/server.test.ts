/** @jest-environment node */
import { headers } from 'next/headers';
import { errorResponse } from './server';

jest.mock('next/headers', () => ({ headers: jest.fn() }));
const mockHeaders = jest.mocked(headers);

describe('async request headers in error responses', () => {
  beforeEach(() => mockHeaders.mockReset());

  it('preserves the forwarded request ID from the asynchronous Next headers API', async () => {
    mockHeaders.mockResolvedValue(new Headers({ 'x-request-id': 'req_forwarded' }));
    const response = await errorResponse('BAD_REQUEST', 'Invalid input', 400);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid input', request_id: 'req_forwarded' },
    });
  });

  it('creates a fallback ID when no request context is available', async () => {
    mockHeaders.mockImplementation(() => { throw new Error('No request context'); });
    const response = await errorResponse('INTERNAL_ERROR', 'Try again');
    expect(response.status).toBe(500);
    expect((await response.json()).error.request_id).toMatch(/^req_/);
  });
});
