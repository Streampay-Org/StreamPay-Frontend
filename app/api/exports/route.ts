import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { tryAuthenticateRequest, JWT_SECRET } from "@/app/lib/auth";
import { ExportJob, getStore } from "@/app/lib/db";
import { checkRateLimit, rateLimitResponse, type ClientIdentity } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";

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

function createErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message, request_id: "mock-request-id" } }, { status });
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

async function enforceExportRateLimit(request: Request, method: "GET" | "POST", walletAddress: string) {
  const url = getRequestUrl(request);
  const limitType = getLimitForRoute(method, url.pathname);
  const identity: ClientIdentity = {
    type: "wallet",
    value: walletAddress,
    displayValue: walletAddress.slice(0, 16) + "...",
  };
  const result = await checkRateLimit(identity, limitType);

  if (!result.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(result.retryAfter!);
  }
  recordRequest(url.pathname);
  return null;
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

export async function POST(request: Request) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return createErrorResponse("UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  // Limit by the verified wallet, after auth, so a forged bearer token can
  // neither mint fresh buckets nor spend another user's budget.
  const rateLimited = await enforceExportRateLimit(request, "POST", actor.walletAddress);
  if (rateLimited) return rateLimited;

  const { exportRepository } = getStore();
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

  return NextResponse.json({ data: job, links: { self: `/api/exports/${id}` } }, { status: 201 });
}

export async function GET(request: Request) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return createErrorResponse("UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const rateLimited = await enforceExportRateLimit(request, "GET", actor.walletAddress);
  if (rateLimited) return rateLimited;

  const jobs = Array.from(getStore().exportRepository.jobs.values())
    .filter((job) => job.ownerId === actor.walletAddress);
  return NextResponse.json({ data: jobs });
}
