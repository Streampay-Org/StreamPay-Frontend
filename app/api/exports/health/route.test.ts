import { GET } from './route';
import { NextRequest } from 'next/server';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: (...args: unknown[]) => mockQuery(...args),
  })),
}));

function buildRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/exports/health', {
    headers: new Headers(headers),
  });
}

describe('GET /api/exports/health', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    process.env.SOROBAN_RPC_URL = 'https://rpc.test/soroban';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns 200 when database and soroban rpc are healthy', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { status: 'healthy' } }),
    }) as unknown as typeof fetch;

    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.dependencies.database.status).toBe('healthy');
    expect(body.dependencies.soroban_rpc.status).toBe('healthy');
  });

  it('returns 503 when database query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection_refused'));
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { status: 'healthy' } }),
    }) as unknown as typeof fetch;

    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(body.dependencies.database.status).toBe('unhealthy');
    expect(body.dependencies.database.error).toBe('connection_refused');
  });

  it('returns 503 when soroban rpc is unreachable', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('fetch_failed')) as unknown as typeof fetch;

    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.dependencies.soroban_rpc.status).toBe('unhealthy');
  });

  it('returns unconfigured status when SOROBAN_RPC_URL is missing', async () => {
    delete process.env.SOROBAN_RPC_URL;
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.dependencies.soroban_rpc.status).toBe('unconfigured');
  });

  it('echoes x-request-id header when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { status: 'healthy' } }),
    }) as unknown as typeof fetch;

    const response = await GET(buildRequest({ 'x-request-id': 'req_test_123' }));
    const body = await response.json();

    expect(body.request_id).toBe('req_test_123');
    expect(response.headers.get('x-request-id')).toBe('req_test_123');
  });
});
