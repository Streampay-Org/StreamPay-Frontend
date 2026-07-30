import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { tryAuthenticateRequest, JWT_SECRET } from "@/app/lib/auth";
import { ExportJob, getStore, encodeCompositeCursor, decodeCompositeCursor } from "@/app/lib/db";
import { checkRateLimit, rateLimitResponse, type ClientIdentity } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { withTimeout } from "@/src/middleware/timeout";
import { withStrongEtag } from "@/src/middleware/etag";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { logAccessEvent } from "@/src/middleware/accessLog";

function getRequestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    return new URL("http://localhost/api/exports");
  }
}

const EXPORT_RETENTION_DAYS = 7;
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const EXPORT_PROCESS_DELAY_MS = 50;

/**
 * Default wall-clock budget for POST/GET /api/exports.
 * Override via the `EXPORTS_TIMEOUT_MS` environment variable.
 */
const EXPORTS_TIMEOUT_MS =
  Number(process.env.EXPORTS_TIMEOUT_MS) || 15_000;

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function createAuditRecord(exportId: string, type: "export.requested" | "export.downloaded" | "export.expired", details?: Record<string, unknown>) {
  getStore().exportRepository.audit.push({
    id: crypto.randomUUID(),
    exportId,
    type,
    timestamp: new Date().toISOString(),
    details,
  });
}

function escapeCsvField(value: string | undefined): string {
  const safe = String(value ?? "").replace(/"/g, '""');
  return `"${safe}"`;
}

/** Creates an HMAC-SHA256 signed download URL scoped to this server. */
function createSignedUrl(jobId: string, expiresAt: string): string {
  const payload = `${jobId}:${expiresAt}`;
  const sig = createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
  const safeId = encodeURIComponent(jobId);
  return `/api/exports/${safeId}?download=true&expires=${encodeURIComponent(expiresAt)}&sig=${sig}`;
}

async function generateExportArtifact(jobId: string) {
  const { exportRepository, streamRepository } = getStore();
  const job = exportRepository.jobs.get(jobId);
  if (!job) return;

  // Scope streams and activity to the job owner
  const streams = Array.from(streamRepository.streams.values())
    .filter((s) => (s as { ownerId?: string }).ownerId === job.ownerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const events = Array.from(streamRepository.activity.values())
    .filter((e) => (e as { ownerId?: string }).ownerId === job.ownerId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const streamRows = streams.map((stream) =>
    ["stream", stream.id, stream.recipient, stream.rate, stream.schedule, stream.status, "", "", ""]
      .map(escapeCsvField)
      .join(",")
  );

  const eventRows = events.map((event) =>
    ["activity", event.streamId ?? "", "", "", "", "", event.type, event.timestamp, event.description]
      .map(escapeCsvField)
      .join(",")
  );

  const allRows = [
    "record_type,stream_id,recipient,rate,schedule,status,event_type,event_timestamp,description",
    ...streamRows,
    ...eventRows,
  ];

  const signedUrlExpiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
  const signedUrl = createSignedUrl(jobId, signedUrlExpiresAt);

  exportRepository.jobs.set(jobId, {
    ...job,
    status: "ready",
    signedUrl,
    signedUrlExpiresAt,
    rows: Math.max(0, allRows.length - 1),
  });

  createAuditRecord(jobId, "export.requested", { rows: allRows.length - 1 });
}

function scheduleExportJob(jobId: string) {
  const { exportRepository } = getStore();
  if (exportRepository.processing.has(jobId)) return;

  const jobPromise = new Promise<void>((resolve) => {
    setTimeout(async () => {
      try {
        await generateExportArtifact(jobId);
      } catch {
        const failedJob = exportRepository.jobs.get(jobId);
        if (failedJob) exportRepository.jobs.set(jobId, { ...failedJob, status: "failed" });
      } finally {
        exportRepository.processing.delete(jobId);
        resolve();
      }
    }, EXPORT_PROCESS_DELAY_MS);
  });

  exportRepository.processing.set(jobId, jobPromise);
}

function recordExportMetrics(method: string, status: number, startedAt: [number, number]) {
  const hrtime = process.hrtime(startedAt);
  const durationMs = hrtime[0] * 1000 + hrtime[1] / 1e6;
  
  if (typeof global !== "undefined" && (global as any).prometheusMetrics) {
    const metrics = (global as any).prometheusMetrics;
    metrics.apiRequestsTotal?.inc({ method, route: "/api/exports", status });
    metrics.apiRequestDuration?.observe({ method, route: "/api/exports", status }, durationMs / 1000);
  } else {
    logger.info("Export metric recorded", { method, status, durationMs, route: "/api/exports" });
  }
}

export async function POST(request: Request) {
  const startedAt = process.hrtime();
  let status = 500;
  let actorId: string | undefined;
  let exportJobId: string | undefined;
  let errorCode: string | undefined;

  try {
    const response = await withTimeout(EXPORTS_TIMEOUT_MS, request, async (_signal) => {
      const { exportRepository } = getStore();
      const actor = tryAuthenticateRequest(request);
      if (!actor) {
        errorCode = "UNAUTHORIZED";
        return createErrorResponse("UNAUTHORIZED", "Missing or invalid authorization header", 401);
      }

      actorId = actor.walletAddress;

      // Limit by the verified wallet, after auth, so a forged bearer token can
      // neither mint fresh buckets nor spend another user's budget.
      const url = getRequestUrl(request);
      const limitType = getLimitForRoute("POST", url.pathname);
      const identity: ClientIdentity = {
        type: "wallet",
        value: actor.walletAddress,
        displayValue: actor.walletAddress.slice(0, 16) + "...",
      };
      const rateCheck = await checkRateLimit(identity, limitType);

      if (!rateCheck.allowed) {
        recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
        errorCode = "RATE_LIMITED";
        return rateLimitResponse(rateCheck.retryAfter!);
      }
      recordRequest(url.pathname);

      const id = crypto.randomUUID();
      const requestedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const job: ExportJob = {
        id,
        ownerId: actor.walletAddress,
        requestedAt,
        status: "pending",
        expiresAt,
        fileName: `streampay-export-${requestedAt.slice(0, 10)}.csv`,
        rows: 0,
      };

      exportRepository.jobs.set(id, job);
      createAuditRecord(id, "export.requested", { requestedAt, retentionDays: EXPORT_RETENTION_DAYS });
      scheduleExportJob(id);

      exportJobId = id;
      return NextResponse.json({ data: job, links: { self: `/api/exports/${id}` } }, { status: 201 });
    });

    status = response.status;
    return response;
  } catch (error) {
    errorCode = "INTERNAL_ERROR";
    const errResp = createErrorResponse("INTERNAL_ERROR", "Export request failed", 500);
    status = errResp.status;
    return errResp;
  } finally {
    const hrtime = process.hrtime(startedAt);
    const durationMs = hrtime[0] * 1000 + hrtime[1] / 1e6;
    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status,
      durationMs,
      actorId,
      exportJobId,
      ...(errorCode ? { errorCode } : {}),
    });
    recordExportMetrics("POST", status, startedAt);
  }
}

export async function GET(request: Request) {
  const startedAt = process.hrtime();
  let status = 500;
  let actorId: string | undefined;
  let errorCode: string | undefined;

  try {
    const response = await withTimeout(EXPORTS_TIMEOUT_MS, request, async (_signal) => {
      const { exportRepository } = getStore();
      const actor = tryAuthenticateRequest(request);
      if (!actor) {
        errorCode = "UNAUTHORIZED";
        return createErrorResponse("UNAUTHORIZED", "Missing or invalid authorization header", 401);
      }

      actorId = actor.walletAddress;

      const url = getRequestUrl(request);
      const limitType = getLimitForRoute("GET", url.pathname);
      const identity: ClientIdentity = {
        type: "wallet",
        value: actor.walletAddress,
        displayValue: actor.walletAddress.slice(0, 16) + "...",
      };
      const rateCheck = await checkRateLimit(identity, limitType);

      if (!rateCheck.allowed) {
        recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
        errorCode = "RATE_LIMITED";
        return rateLimitResponse(rateCheck.retryAfter!);
      }
      recordRequest(url.pathname);

      const searchParams = url.searchParams;
      const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 10));
      const cursor = searchParams.get("cursor");

      let jobs = Array.from(exportRepository.jobs.values())
        .filter((job) => job.ownerId === actor.walletAddress)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

      let startIndex = 0;
      if (cursor) {
        const decoded = decodeCompositeCursor(cursor);
        const idx = jobs.findIndex((j) => j.id === decoded?.id);
        if (idx >= 0) {
          startIndex = idx;
        }
      }

      const paginatedJobs = jobs.slice(startIndex, startIndex + limit);
      const hasNext = startIndex + limit < jobs.length;
      let nextCursor = null;

      if (hasNext) {
        const nextJob = jobs[startIndex + limit];
        nextCursor = encodeCompositeCursor({ id: nextJob.id, timestamp: nextJob.requestedAt });
      }

      const payload = {
        data: paginatedJobs,
        links: { self: `/api/exports?limit=${limit}` },
        meta: { hasNext, nextCursor, total: jobs.length },
      };

      logger.info("Exports listed successfully", {
        count: paginatedJobs.length,
        total: jobs.length,
        limit,
        request_id: getCorrelationContext()?.request_id,
      });

      // Strong ETag / 304 for conditional GET (Issue #1120)
      return withStrongEtag(request, payload);
    });

    status = response.status;
    return response;
  } catch (error) {
    errorCode = "INTERNAL_ERROR";
    const errResp = createErrorResponse("INTERNAL_ERROR", "Export listing failed", 500);
    status = errResp.status;
    return errResp;
  } finally {
    const hrtime = process.hrtime(startedAt);
    const durationMs = hrtime[0] * 1000 + hrtime[1] / 1e6;
    logAccessEvent({
      method: "GET",
      path: "/api/exports",
      status,
      durationMs,
      actorId,
      ...(errorCode ? { errorCode } : {}),
    });
    recordExportMetrics("GET", status, startedAt);
  }
}
