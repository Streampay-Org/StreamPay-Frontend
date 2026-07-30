import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getCorrelationContext, logger } from '@/app/lib/logger';
import { encodeCompositeCursor, decodeCompositeCursor } from '@/app/lib/db';
import { withStrongEtag } from '@/src/middleware/etag';
import { applyRateLimit } from '@/src/middleware/rateLimit';
import { reconciliationCounter, reconciliationDuration } from '@/src/metrics/registry';
import { validateReconciliationQuery } from '@/src/validators/reconciliation';
import type { ValidationError } from '@/app/lib/stream-validation';

function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** 422 envelope with per-field details, matching /api/streams and /api/auth/wallet. */
function validationErrorResponse(logMessage: string, errors: ValidationError[]) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  logger.warn(logMessage, { errors, request_id: requestId });
  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'One or more fields are invalid.',
        details: errors,
        request_id: requestId,
      },
    },
    { status: 422 },
  );
}

export async function GET(request: Request) {
  const endTimer = reconciliationDuration.startTimer();

  // ── Per-user rate limit ─────────────────────────────────────────────────
  // Identity resolution priority: API key > JWT wallet sub > IP address.
  // Returns 429 with Retry-After when the caller's bucket is exhausted.
  const rateLimited = await applyRateLimit(request, 'reconciliation');
  if (rateLimited) {
    reconciliationCounter.labels('429').inc();
    endTimer({ status: '429' });
    return rateLimited;
  }

  // ── Request handling ────────────────────────────────────────────────────
  try {
    const url = new URL(request.url);

    // Validate query params (limit / cursor / status) via the shared Zod
    // schema (Issue #1136). Returns a per-field 422 envelope consistent
    // with /api/streams and /api/auth/wallet.
    const parsed = validateReconciliationQuery({
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });

    if (!parsed.ok) {
      logger.warn('Invalid reconciliation query params', { errors: parsed.errors });
      reconciliationCounter.labels('422').inc();
      endTimer({ status: '422' });
      return validationErrorResponse('Invalid reconciliation query', parsed.errors);
    }

    const limit = parsed.data.limit ?? 100;
    const statusFilter = parsed.data.status;
    const cursor = parsed.data.cursor;

    logger.info('Fetching public reconciliation overview', {
      limit,
      status: statusFilter,
      cursor: cursor ?? null,
      request_id: getCorrelationContext()?.request_id,
    });

    // Mock representation of public reconciliation status for the FWC26
    // campaign. Stable (created_at DESC, id ASC) order — same convention
    // the cursor encodes (`decodeCompositeCursor` returns timestamp+id
    // and the route filters rows strictly older than the cursor).
    const allRows = [
      { id: 'rec-pub-1', totalReconciled: 1500, currency: 'XLM', status: 'completed' as const, created_at: '2026-01-03T00:00:00.000Z' },
      { id: 'rec-pub-2', totalReconciled: 300, currency: 'USDC', status: 'pending' as const, created_at: '2026-01-02T00:00:00.000Z' },
      { id: 'rec-pub-3', totalReconciled: 250, currency: 'USDC', status: 'failed' as const, created_at: '2026-01-01T00:00:00.000Z' },
    ];

    let rows = statusFilter
      ? allRows.filter((row) => row.status === statusFilter)
      : allRows.slice();

    if (cursor) {
      try {
        const { timestamp: cursorTs, id: cursorId } = decodeCompositeCursor(cursor);
        rows = rows.filter((row) => {
          const tsCmp = row.created_at.localeCompare(cursorTs);
          return tsCmp < 0 || (tsCmp === 0 && row.id.localeCompare(cursorId) < 0);
        });
      } catch {
        logger.warn('Malformed cursor', { cursor });
        reconciliationCounter.labels('422').inc();
        endTimer({ status: '422' });
        return errorResponse('INVALID_CURSOR', 'Query param cursor is malformed.', 422);
      }
    }

    const paginated = rows.slice(0, limit);
    const hasNext = rows.length > limit;
    const lastRow = paginated[paginated.length - 1];
    const nextCursor =
      hasNext && lastRow ? encodeCompositeCursor(lastRow.created_at, lastRow.id) : null;

    const responsePayload = {
      status: 'success',
      data: paginated,
      meta: {
        total: rows.length,
        limit,
        hasNext,
        nextCursor,
      },
    };

    reconciliationCounter.labels('200').inc();
    endTimer({ status: '200' });
    return withStrongEtag(request, responsePayload);
  } catch (error: any) {
    logger.error('Unexpected error in reconciliation route', { error: error.message });
    reconciliationCounter.labels('500').inc();
    endTimer({ status: '500' });
    return errorResponse('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', 500);
  }
}
