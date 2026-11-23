import { NextResponse } from "next/server";
import { requireAdmin, resolveCallerAddress } from "@/app/lib/admin-guard";
import { computeStreamDiff } from "@/app/lib/reconciliation-diff";
import { getCorrelationContext, logger } from "@/app/lib/logger";

/**
 * GET /api/reconciliation/diff/:id
 *
 * Read-only, admin-gated proxy for the internal reconciliation diff. It runs
 * the same `ReconciliationService` comparison as
 * `/api/internal/reconciliation/diff/:id` but authenticates with the admin
 * guard (verified JWT or `Actor-Wallet-Address`) so the ops dashboard in the
 * browser can call it. No internal HMAC credentials are accepted or echoed.
 *
 * Responses:
 *   200 `{ data: { streamId, checkedAt, inSync, diffs, db, onChain } }`
 *   400 `BAD_REQUEST`         — empty stream id.
 *   401 `UNAUTHORIZED`        — no caller identity.
 *   403 `Unauthorized`        — caller is not the admin.
 *   404 `STREAM_NOT_FOUND`    — unknown to both the DB and the chain.
 *   500 `INTERNAL_SERVER_ERROR`
 */

function errorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id ?? "unknown-request-id" } },
    { status },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: streamId } = await params;

  if (!streamId || typeof streamId !== "string" || streamId.trim() === "") {
    return errorResponse("BAD_REQUEST", "Stream ID is required.", 400);
  }

  if (!resolveCallerAddress(request)) {
    return errorResponse("UNAUTHORIZED", "A verified caller identity is required.", 401);
  }

  const admin = requireAdmin(request);
  if (admin instanceof NextResponse) {
    return admin;
  }

  try {
    const diff = await computeStreamDiff(streamId);
    if (!diff) {
      logger.warn("reconciliation.diff proxy stream not found", { stream_id: streamId });
      return errorResponse("STREAM_NOT_FOUND", `Stream '${streamId}' not found.`, 404);
    }

    logger.info("reconciliation.diff proxy served", {
      stream_id: streamId,
      in_sync: diff.inSync,
      diff_count: diff.diffs.length,
    });

    return NextResponse.json(
      { data: diff },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    logger.error("reconciliation.diff proxy failed", {
      stream_id: streamId,
      error: error?.message ?? String(error),
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", 500);
  }
}
