import { NextResponse } from "next/server";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { computeStreamDiff } from "@/app/lib/reconciliation-diff";
import { logger } from "@/app/lib/logger";

/**
 * GET /api/internal/reconciliation/diff/:id
 *
 * Returns a structured diff between the DB record and on-chain state for a
 * single stream. Intended for use by internal services (ops-automation,
 * reconciliation-worker) to inspect individual stream discrepancies without
 * triggering a full reconciliation run.
 *
 * Auth: HMAC-signed service-to-service headers (same scheme as POST
 *       /api/internal/reconciliation). The route is concealed behind a 404
 *       on any auth failure to avoid leaking its existence.
 *
 * Response 200:
 * {
 *   "data": {
 *     "streamId": "stream_2",
 *     "checkedAt": "2026-06-29T…",
 *     "inSync": false,
 *     "diffs": [
 *       { "field": "released_amount", "dbValue": "1000000000", "onChainValue": "1100000000", "toleranceApplied": false }
 *     ],
 *     "db": { … },
 *     "onChain": { … }
 *   },
 *   "meta": { "auth": { "keyId": "…", "timestamp": "…" } }
 * }
 *
 * Response 404: stream not found in DB or on-chain (or auth failure, concealed).
 */
function createErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status }
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: streamId } = await params;

  // Validate streamId is a non-empty string
  if (!streamId || typeof streamId !== "string" || streamId.trim() === "") {
    return createErrorResponse("BAD_REQUEST", "Stream ID is required.", 400);
  }

  // Require internal service authentication; conceal the route on failure
  const identity = await requireInternalServiceAuth(request, {
    allowedServices: ["ops-automation", "reconciliation-worker"],
    concealFailure: true,
  });

  if (identity instanceof NextResponse) {
    return identity;
  }

  logger.info("reconciliation.diff requested", {
    stream_id: streamId,
    requested_by: identity.serviceName,
    key_id: identity.keyId,
  });

  const diff = await computeStreamDiff(streamId);

  // Return 404 if the stream is unknown to both DB and on-chain
  if (!diff) {
    logger.warn("reconciliation.diff stream not found", { stream_id: streamId });
    return createErrorResponse(
      "STREAM_NOT_FOUND",
      `Stream '${streamId}' not found.`,
      404
    );
  }

  logger.info("reconciliation.diff completed", {
    stream_id: streamId,
    in_sync: diff.inSync,
    diff_count: diff.diffs.length,
  });

  return NextResponse.json(
    {
      data: {
        ...diff,
        dryRun: true,
        mode: "DRY_RUN",
      },
      meta: {
        auth: {
          keyId: identity.keyId,
          timestamp: identity.timestamp,
        },
      },
    },
    { status: 200 }
  );
}
