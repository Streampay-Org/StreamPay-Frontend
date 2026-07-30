import { NextRequest, NextResponse } from 'next/server';
import { withAccessLog } from './accessLog';
import { v4 as uuidv4 } from 'uuid';

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234')
}));

describe('withAccessLog', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs incoming request and completion with correlation ID', async () => {
    const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true }, { status: 200 }));
    const wrappedHandler = withAccessLog(handler);
    
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST',
      headers: { 'x-correlation-id': 'custom-id-5678' }
    });

    const res = await wrappedHandler(req);

    expect(handler).toHaveBeenCalledWith(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('custom-id-5678');
    
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    
    const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(log1.level).toBe('info');
    expect(log1.message).toBe('Incoming webhook request');
    expect(log1.correlation_id).toBe('custom-id-5678');
    expect(log1.method).toBe('POST');

    const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
    expect(log2.level).toBe('info');
    expect(log2.message).toBe('Webhook request completed');
    expect(log2.correlation_id).toBe('custom-id-5678');
    expect(log2.status).toBe(200);
  });

  it('generates a correlation ID if missing', async () => {
    const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true }, { status: 201 }));
    const wrappedHandler = withAccessLog(handler);
    
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST'
    });

    const res = await wrappedHandler(req);

    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('test-uuid-1234');
    
    const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(log1.correlation_id).toBe('test-uuid-1234');
  });

  it('catches errors, logs them, and returns a standardized error envelope', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('Test error'));
    const wrappedHandler = withAccessLog(handler);
    
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST'
    });

    const res = await wrappedHandler(req);

    expect(res.status).toBe(500);
    expect(res.headers.get('x-correlation-id')).toBe('test-uuid-1234');
    
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred during webhook processing.'
      },
      correlation_id: 'test-uuid-1234'
    });
    
    expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only incoming log
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // Error log
    
    const errorLog = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorLog.level).toBe('error');
    expect(errorLog.message).toBe('Webhook request failed');
    expect(errorLog.correlation_id).toBe('test-uuid-1234');
    expect(errorLog.error).toBe('Test error');
  });

  it('handles non-Error thrown objects', async () => {
    const handler = jest.fn().mockRejectedValue('String error');
    const wrappedHandler = withAccessLog(handler);
    
    const req = new NextRequest('https://example.com/api/webhooks', {
      method: 'POST'
    });

    await wrappedHandler(req);
    
    const errorLog = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorLog.error).toBe('String error');
  });
});
