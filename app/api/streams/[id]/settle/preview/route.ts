/**
 * GET /api/streams/:id/settle/preview
 *
 * Read-only preview of settling a stream at the current instant.
 * Computes the transition and escrow amounts without mutating state
 * or emitting history, audit, or webhook side effects.
 */

import { NextResponse } from "next/server";
import { db } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamOrgPolicy, requireStreamActor } from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { escrowNow } from "@/app/lib/escrow-state";
import { previewSettleOutcome } from "@/app/lib/stream-outcome-preview";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function createErrorResponse(code: string, message: string, status: number, legacyCode?: string) {
  const ctx = getCorrelationContext();
  return NextResponse.json(
    { error: { code, ...(legacyCode ? { legacy_code: legacyCode } : {}), message, request_id: ctx?.request_id } },
    { status, headers: NO_STORE_HEADERS },
  );
}

function getRequestUrl(req: Request, fallback: string): URL {
  try {
    return req.url ? new URL(req.url) : new URL(`http://localhost${fallback}`);
  } catch {
    return new URL(`http://localhost${fallback}`);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const path = `/api/streams/${id}/settle/preview`;
  const url = getRequestUrl(request, path);

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const rl = await checkRateLimit(identity, limitType);
  if (!rl.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rl.retryAfter!);
  }
  recordRequest(url.pathname);

  // ── Fetch stream (tenant-scoped when header is provided) ───────────────────
  const tenant = request.headers?.get?.("x-tenant-id")?.trim();
  const stream = tenant && db.streams.findOne ? db.streams.findOne(tenant, id) : db.streams.get(id);
  if (!stream) {
    return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // ── Authorization (mirrors POST /settle RBAC, read-only) ───────────────────
  const actorResult = requireStreamActor(request);
  if (actorResult instanceof NextResponse) return actorResult;

  if (orgDb.streamOwnership.has(id)) {
    const policyResult = checkStreamOrgPolicy(id, actorResult, "settle");
    if (policyResult && !policyResult.allowed) {
      return createErrorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
    }
  }

  // ── Compute read-only preview ──────────────────────────────────────────────
  const preview = previewSettleOutcome(stream, escrowNow());
  if (!preview.ok) {
    return createErrorResponse(preview.code, preview.message, preview.httpStatus, preview.legacyCode);
  }

  return NextResponse.json(
    { data: preview.data },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
