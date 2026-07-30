import { NextRequest } from 'next/server';
import { POST } from './route';

jest.mock('@/src/middleware/accessLog', () => ({
  // Mocking the middleware to just call the handler directly to test the route logic itself
  // However, we want to test the integrated behavior or just the route.
  // We'll mock it to pass through while keeping correlation ID logic simple, 
  // or we can test without mocking it to ensure full coverage. Let's unmock it.
}));

// We'll use the actual middleware to ensure integration works
jest.unmock('@/src/middleware/accessLog');

describe('POST /api/webhooks', () => {
  let consoleLogSpy: jest.SpyInstance;
  
  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST',
      body: 'invalid-json',
      headers: { 'x-correlation-id': 'test-123' }
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON.'
      }
    });
    expect(res.headers.get('x-correlation-id')).toBe('test-123');
  });

  it('returns 400 for non-object payload (array)', async () => {
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST',
      body: JSON.stringify([{ id: 1 }]),
      headers: { 'x-correlation-id': 'test-123' }
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('returns 400 for null payload', async () => {
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST',
      body: JSON.stringify(null),
      headers: { 'x-correlation-id': 'test-123' }
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('returns 200 for valid JSON object', async () => {
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({ event: 'stream.created', data: {} }),
      headers: { 'x-correlation-id': 'test-123' }
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    
    // Check if the middleware logged the interaction
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});
