import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { logger } from "@/app/lib/logger";
import { settleStreamById } from "@/app/lib/settle-stream";
import type { Stream } from "@/app/types/openapi";
import { settleJobRunsCounter, settleJobStreamsCounter } from "@/src/metrics/registry";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SETTLEABLE_STATUSES = new Set<Stream["status"]>(["active", "paused"]);

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function isPastEndTime(stream: Stream, nowMs: number): boolean {
  if (!SETTLEABLE_STATUSES.has(stream.status)) {
    return false;
  }
  if (typeof stream.endTime !== "string" || stream.endTime.trim().length === 0) {
    return false;
  }
  const endMs = Date.parse(stream.endTime);
  if (!Number.isFinite(endMs)) {
    return false;
  }
  return endMs < nowMs;
}

/**
 * POST /api/internal/jobs/settle-ended
 *
 * Periodic internal job that finds `active` or `paused` streams whose `endTime`
 * has passed and settles them via the shared settlement workflow (`settleStreamById`).
 *
 * ## Authentication
 * Requires signed internal service auth (`ops-automation` or `settle-worker`).
 * Auth failures are concealed as 404.
 *
 * ## Request body (optional JSON)
 * - `dryRun` (boolean, default `false`) — report eligible candidates without mutating state.
 * - `limit` (integer, default `100`, max `500`) — maximum number of streams to process per run.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const identity = await requireInternalServiceAuth(request, {
    allowedServices: ["ops-automation", "settle-worker"],
    concealFailure: true,
  });

  if (identity instanceof NextResponse) {
    return identity;
  }

  let dryRun = false;
  let limit = DEFAULT_LIMIT;

  try {
    const raw = await request.clone().text();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw) as { dryRun?: unknown; limit?: unknown };
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResponse("INVALID_REQUEST", "Request body must be a JSON object.", 400);
      }

      if (parsed.dryRun !== undefined) {
        if (typeof parsed.dryRun !== "boolean") {
          return errorResponse("INVALID_REQUEST", "`dryRun` must be a boolean.", 400);
        }
        dryRun = parsed.dryRun;
      }

      if (parsed.limit !== undefined) {
        if (
          typeof parsed.limit !== "number" ||
          !Number.isInteger(parsed.limit) ||
          parsed.limit < 1 ||
          parsed.limit > MAX_LIMIT
        ) {
          return errorResponse(
            "INVALID_REQUEST",
            `\`limit\` must be an integer between 1 and ${MAX_LIMIT}.`,
            400,
          );
        }
        limit = parsed.limit;
      }
    }
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  const streamStore = getStore().streamRepository.streams;
  const nowMs = Date.now();

  let scanned = 0;
  const eligibleStreams: Stream[] = [];
  for (const stream of streamStore.values()) {
    scanned += 1;
    if (isPastEndTime(stream, nowMs)) {
      eligibleStreams.push(stream);
    }
  }

  const batch = eligibleStreams.slice(0, limit);

  if (dryRun) {
    settleJobRunsCounter.inc({ dry_run: "true" });
    logger.info("Settle-ended job dry run completed", {
      service: identity.serviceName,
      scanned,
      eligible: eligibleStreams.length,
      processed: batch.length,
      dryRun: true,
      limit,
    });

    return NextResponse.json({
      scanned,
      eligible: eligibleStreams.length,
      processed: batch.length,
      settled: 0,
      skipped: 0,
      failed: 0,
      failedStreamIds: [],
      candidates: batch.map((stream) => stream.id),
      dryRun: true,
      limit,
    });
  }

  let settled = 0;
  let skipped = 0;
  let failed = 0;
  const failedStreamIds: string[] = [];

  for (const candidate of batch) {
    const outcome = await settleStreamById({
      streamId: candidate.id,
      request,
      actorAddress: null,
    });

    if (outcome.ok) {
      if (outcome.idempotent) {
        skipped += 1;
        settleJobStreamsCounter.inc({ result: "skipped" });
      } else {
        settled += 1;
        settleJobStreamsCounter.inc({ result: "settled" });
      }
    } else if (outcome.reason === "not_found" || outcome.reason === "invalid_state") {
      skipped += 1;
      settleJobStreamsCounter.inc({ result: "skipped" });
    } else {
      failed += 1;
      failedStreamIds.push(candidate.id);
      settleJobStreamsCounter.inc({ result: "failed" });
      logger.error("Failed to settle ended stream", {
        service: identity.serviceName,
        streamId: candidate.id,
      });
    }
  }

  settleJobRunsCounter.inc({ dry_run: "false" });

  logger.info("Settle-ended job completed", {
    service: identity.serviceName,
    scanned,
    eligible: eligibleStreams.length,
    processed: batch.length,
    settled,
    skipped,
    failed,
    dryRun: false,
    limit,
  });

  return NextResponse.json({
    scanned,
    eligible: eligibleStreams.length,
    processed: batch.length,
    settled,
    skipped,
    failed,
    failedStreamIds,
    dryRun: false,
    limit,
  });
}
