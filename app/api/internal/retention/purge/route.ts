import { NextResponse } from "next/server";
import { auditLogStore, buildRequestId } from "@/app/lib/audit-log";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { logger } from "@/app/lib/logger";
import {
  DEFAULT_RETENTION_PURGE_LIMIT,
  MAX_RETENTION_PURGE_LIMIT,
  purgeExpiredStreams,
} from "@/app/lib/retention";

export const RETENTION_PURGE_ACTION = "retention.purge";
const INTERNAL_ACTOR_ID = "internal-service";

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * POST /api/internal/retention/purge
 *
 * Periodic internal job that scrubs PII (`email`, `label`, `memo`, `partnerId`)
 * from streams whose `createdAt` is older than the seven-year retention window.
 * Aggregate fields stay so accounting and audit history remain intact, matching
 * the policy in docs/PRIVACY.md.
 *
 * ## Authentication
 * Requires a signed internal-service request (see
 * {@link requireInternalServiceAuth}). Only `ops-automation` may call it. Auth
 * failures are concealed as 404 so the route is not discoverable.
 *
 * ## Request body (optional JSON)
 * - `dryRun` (boolean) — report what would be purged without mutating anything.
 *   Defaults to `false`.
 * - `limit` (integer, 1–500) — maximum streams to purge per run. Defaults to 100.
 *
 * ## Response
 * ```json
 * { "scanned": 120, "eligible": 7, "alreadyScrubbed": 1, "purged": 6,
 *   "remaining": 0, "selectedIds": ["stream-old"], "purgedIds": ["stream-old"],
 *   "cutoff": "2019-11-23T12:00:00.000Z", "dryRun": false, "limit": 100 }
 * ```
 *
 * One `retention.purge` audit event is appended per purged stream. A dry run
 * writes no audit events and mutates nothing.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const identity = await requireInternalServiceAuth(request, {
    allowedServices: ["ops-automation"],
    concealFailure: true,
  });

  if (identity instanceof NextResponse) {
    return identity;
  }

  let dryRun = false;
  let limit = DEFAULT_RETENTION_PURGE_LIMIT;

  try {
    const raw = await request.clone().text();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw) as { dryRun?: unknown; limit?: unknown };
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse(
          "INVALID_REQUEST",
          "Request body must be a JSON object.",
          400
        );
      }

      if (parsed.dryRun !== undefined) {
        if (typeof parsed.dryRun !== "boolean") {
          return errorResponse(
            "INVALID_REQUEST",
            "`dryRun` must be a boolean.",
            400
          );
        }
        dryRun = parsed.dryRun;
      }

      if (parsed.limit !== undefined) {
        if (
          typeof parsed.limit !== "number" ||
          !Number.isInteger(parsed.limit) ||
          parsed.limit < 1 ||
          parsed.limit > MAX_RETENTION_PURGE_LIMIT
        ) {
          return errorResponse(
            "INVALID_REQUEST",
            `\`limit\` must be an integer between 1 and ${MAX_RETENTION_PURGE_LIMIT}.`,
            400
          );
        }
        limit = parsed.limit;
      }
    }
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  const result = purgeExpiredStreams({ dryRun, limit });
  const requestId = buildRequestId(request);

  if (!dryRun) {
    for (const streamId of result.purgedIds) {
      auditLogStore.append({
        action: RETENTION_PURGE_ACTION,
        actor: { id: INTERNAL_ACTOR_ID, role: "system" },
        target: { type: "stream", id: streamId },
        before: { piiRetained: true },
        after: { piiRetained: false },
        requestId,
        metadata: {
          cutoff: result.cutoff,
          service: identity.serviceName,
        },
      });
    }
  }

  logger.info("Retention purge completed", {
    scanned: result.scanned,
    eligible: result.eligible,
    alreadyScrubbed: result.alreadyScrubbed,
    purged: result.purged,
    remaining: result.remaining,
    dryRun: result.dryRun,
    limit: result.limit,
    requestId,
  });

  return NextResponse.json({
    scanned: result.scanned,
    eligible: result.eligible,
    alreadyScrubbed: result.alreadyScrubbed,
    purged: result.purged,
    remaining: result.remaining,
    selectedIds: result.selectedIds,
    purgedIds: result.purgedIds,
    cutoff: result.cutoff,
    dryRun: result.dryRun,
    limit: result.limit,
  });
}
