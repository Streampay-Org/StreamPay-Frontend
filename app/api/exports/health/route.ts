import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

export const dynamic = 'force-dynamic';

const HEALTH_TIMEOUT_MS = 3000;

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: HEALTH_TIMEOUT_MS,
    });
  }
  return pool;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function checkDatabase(): Promise<{ status: string; latency_ms: number; error?: string }> {
  const start = Date.now();
  try {
    const client = getPool();
    await withTimeout(client.query('SELECT 1'), HEALTH_TIMEOUT_MS, 'database');
    return { status: 'healthy', latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: 'unhealthy',
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : 'unknown_error',
    };
  }
}

async function checkSorobanRpc(): Promise<{ status: string; latency_ms: number; error?: string }> {
  const start = Date.now();
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  if (!rpcUrl) {
    return { status: 'unconfigured', latency_ms: 0, error: 'SOROBAN_RPC_URL_missing' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: 'unhealthy',
        latency_ms: Date.now() - start,
        error: `http_${response.status}`,
      };
    }
    const body = await response.json();
    const healthy = body?.result?.status === 'healthy';
    return {
      status: healthy ? 'healthy' : 'unhealthy',
      latency_ms: Date.now() - start,
      ...(healthy ? {} : { error: 'rpc_status_not_healthy' }),
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : 'unknown_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? `req_${crypto.randomUUID()}`;
  const startedAt = Date.now();

  const [database, soroban] = await Promise.all([checkDatabase(), checkSorobanRpc()]);

  const dependencies = { database, soroban_rpc: soroban };
  const allHealthy = Object.values(dependencies).every((dep) => dep.status === 'healthy');
  const durationMs = Date.now() - startedAt;

  console.log(
    JSON.stringify({
      level: allHealthy ? 'info' : 'warn',
      event: 'exports_health_check',
      request_id: requestId,
      duration_ms: durationMs,
      dependencies,
    })
  );

  if (!allHealthy) {
    return NextResponse.json(
      {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'One or more export dependencies are unhealthy.',
          request_id: requestId,
        },
        dependencies,
      },
      { status: 503, headers: { 'x-request-id': requestId } }
    );
  }

  return NextResponse.json(
    {
      status: 'healthy',
      request_id: requestId,
      duration_ms: durationMs,
      dependencies,
    },
    { status: 200, headers: { 'x-request-id': requestId } }
  );
}
