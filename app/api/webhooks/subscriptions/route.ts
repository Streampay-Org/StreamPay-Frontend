/**
 * GET /api/webhooks/subscriptions
 *
 * Read-only, admin-only list of webhook subscriptions for the
 * /settings/webhooks console.
 *
 * The signing `secret` is NEVER returned: each record is passed through
 * `toPublicSubscription`, which drops it and exposes only `hasSecret`.
 *
 * Query params (optional, forwarded to the store):
 *   - status     "active" | "inactive"
 *   - event_type substring match against the subscription's event types
 *
 * | Code                | HTTP | Meaning                            |
 * |---------------------|------|------------------------------------|
 * | UNAUTHORIZED        | 401  | Missing or invalid bearer token    |
 * | FORBIDDEN           | 403  | Authenticated, but not an admin    |
 * | VALIDATION_ERROR    | 400  | Unknown `status` filter            |
 * | SUBSCRIPTIONS_FAILED| 500  | Store failure                      |
 */

import { NextResponse } from 'next/server';
import { tryAuthenticateRequest } from '@/app/lib/auth';
import {
  getWebhookSubscriptionStore,
  toPublicSubscription,
} from '@/app/lib/webhook-store';
import { withTimeout, WEBHOOK_TIMEOUT_MS } from '@/src/middleware/timeout';

export const dynamic = 'force-dynamic';

function err(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(request: Request) {
  return withTimeout(WEBHOOK_TIMEOUT_MS, request, async () => {
    const auth = tryAuthenticateRequest(request);
    if (!auth) {
      return err('UNAUTHORIZED', 'Admin authentication required', 401);
    }
    if (auth.role !== 'admin') {
      return err('FORBIDDEN', 'Admin role required', 403);
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') ?? undefined;
    const eventType = searchParams.get('event_type') ?? undefined;

    if (status !== undefined && status !== 'active' && status !== 'inactive') {
      return err('VALIDATION_ERROR', "Query param 'status' must be 'active' or 'inactive'.", 400);
    }

    try {
      const subscriptions = await getWebhookSubscriptionStore().list({ status, eventType });
      const data = subscriptions.map(toPublicSubscription);
      return NextResponse.json({ data, meta: { total: data.length } });
    } catch {
      return err('SUBSCRIPTIONS_FAILED', 'Failed to list webhook subscriptions.', 500);
    }
  });
}
