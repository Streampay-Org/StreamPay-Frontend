import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { tryAuthenticateRequest, getJwtSecret } from "@/app/lib/auth";
import { ExportJob, getStore, encodeCompositeCursor, decodeCompositeCursor } from "@/app/lib/db";
import { checkRateLimit, rateLimitResponse, type ClientIdentity } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { withTimeout } from "@/src/middleware/timeout";
import { withStrongEtag } from "@/src/middleware/etag";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { logAccessEvent } from "@/src/middleware/accessLog";
import { exportCounter, exportDuration } from "@/src/metrics/registry";

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

/** Default page size for GET /api/exports when no `limit` is supplied. */
const DEFAULT_PAGE_SIZE = 20;

/** Upper bound for the `limit` query parameter on GET /api/exports. */
const MAX_PAGE_SIZE = 100;

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
  const sig = createHmac("sha256", getJwtSecret()).update(payload).digest("hex");
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

/**
 * Observe the Prometheus counter + histogram for an /api/exports request.
 *
 * Every code path records exactly one sample - including auth failures,
 * validation errors and rate-limit rejections - so the scrape surface
 * reflects real traffic and not only successful exports.
 */
function recordExportMetrics(method: "GET" | "POST", status: number, startedAt: [number, number]) {
  const diff = process.hrtime(startedAt);
  const durationSeconds = diff[0] + diff[1] / 1e9;
  const labels = { status: String(status), method };
  exportCounter.inc(labels);
  exportDuration.observe(labels, durationSeconds);
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

      let body: unknown = {};
      if (request.headers.get("content-type")?.includes("application/json")) {
        try {
          body = await request.json();
        } catch {
          errorCode = "INVALID_JSON";
          return createErrorResponse("INVALID_JSON", "Malformed JSON body", 400);
        }
      }

      const { validateExportRequest } = await import("@/src/validators/exports");
      const validation = validateExportRequest(body);
      
      if (!validation.success) {
        errorCode = "VALIDATION_FAILED";
        const context = getCorrelationContext();
        return NextResponse.json({
          error: {
            code: "VALIDATION_FAILED",
            message: "Invalid export filters",
            details: validation.errors,
            request_id: context?.request_id
          }
        }, { status: 400 });
      }

      const filters = validation.data;

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
      const limitParam = searchParams.get("limit");
      const limit =
        limitParam === null || limitParam.trim() === "" ? DEFAULT_PAGE_SIZE : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        errorCode = "VALIDATION_ERROR";
        return createErrorResponse(
          "VALIDATION_ERROR",
          `Invalid limit parameter. Must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
          422,
        );
      }

      const cursor = searchParams.get("cursor");
      const ownedJobs = Array.from(exportRepository.jobs.values())
        .filter((job) => job.ownerId === actor.walletAddress)
        .sort((a, b) => {
          const timeCompare = b.requestedAt.localeCompare(a.requestedAt);
          return timeCompare !== 0 ? timeCompare : b.id.localeCompare(a.id);
        });
      const total = ownedJobs.length;

      let jobs = ownedJobs;
      if (cursor) {
        let decoded: { timestamp: string; id: string };
        try {
          decoded = decodeCompositeCursor(cursor);
        } catch {
          errorCode = "INVALID_CURSOR";
          return createErrorResponse("INVALID_CURSOR", "Malformed cursor", 422);
        }
        // The cursor points at the last row of the previous page. When that row
        // has since been deleted we still resume at the right position by
        // comparing the (requestedAt, id) key instead of restarting at page one.
        const cursorIndex = ownedJobs.findIndex(
          (job) => job.requestedAt === decoded.timestamp && job.id === decoded.id,
        );
        jobs =
          cursorIndex >= 0
            ? ownedJobs.slice(cursorIndex + 1)
            : ownedJobs.filter((job) => {
                const timeCompare = job.requestedAt.localeCompare(decoded.timestamp);
                return (
                  timeCompare < 0 ||
                  (timeCompare === 0 && job.id.localeCompare(decoded.id) < 0)
                );
              });
      }

      const paginatedJobs = jobs.slice(0, limit);
      const hasNext = jobs.length > limit;
      const lastJob = paginatedJobs[paginatedJobs.length - 1];
      const nextCursor =
        hasNext && lastJob ? encodeCompositeCursor(lastJob.requestedAt, lastJob.id) : null;

      const payload = {
        data: paginatedJobs,
        links: { self: `/api/exports?limit=${limit}` },
        meta: { hasNext, nextCursor, total },
      };

      logger.info("Exports listed successfully", {
        count: paginatedJobs.length,
        total,
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
