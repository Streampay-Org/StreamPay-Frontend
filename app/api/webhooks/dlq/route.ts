import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";
import type { WebhookEndpoint, WebhookEvent } from "@/app/lib/webhook-delivery";
import { appendToOutbox, getOutboxStore } from "@/lib/outbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/webhooks/dlq
 *
 * Admin-only list of dead-letter entries (newest first) for the
 * /settings/webhooks console. The raw event payload is not included; the
 * console only needs identifiers, the failure reason and attempt history.
 *
 * 401 when the bearer token is missing/invalid, 403 for non-admin roles.
 */
export async function GET(req: Request) {
  const auth = tryAuthenticateRequest(req);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Admin authentication required" } },
      { status: 401 },
    );
  }
  if (auth.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Admin role required" } },
      { status: 403 },
    );
  }

  const data = webhookDeliveryStore
    .getAllDLQEntries()
    .map((entry) => ({
      id: entry.id,
      deliveryId: entry.deliveryId,
      endpointId: entry.endpointId,
      endpointUrl: entry.endpointUrl,
      eventId: entry.eventId,
      eventType: entry.eventType,
      reason: entry.reason,
      attempts: entry.allAttempts,
      createdAt: entry.createdAt,
      replayedDeliveryId: entry.replayedDeliveryId ?? null,
      replayedAt: entry.replayedAt ?? null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({ data, meta: { total: data.length } }, { status: 200 });
}

/**
 * POST /api/webhooks/dlq
 *
 * Receives dead-letter-queue webhook events for reprocessing.
 *
 * Requires internal-service HMAC auth or an admin JWT (parity with
 * POST /api/webhooks/dlq/:dlqId/replay).
 *
 * When the request body contains a structured `{ endpoint, event }` payload,
 * the event is validated (including SSRF checks on `endpoint.url`) and recorded
 * idempotently in the transactional outbox so the drain worker can deliver it
 * reliably — surviving any crash between receipt and actual delivery.
 *
 * When the body is a generic JSON object (legacy / unstructured), the endpoint
 * still acknowledges receipt (backward-compatible).
 *
 * Returns 202 for structured payloads, 200 for legacy unstructured objects,
 * or the canonical error envelope on failure.
 */
export async function POST(req: NextRequest) {
  const authError = await authenticatePost(req);
  if (authError) {
    return authError;
  }

  try {
    const body = await req.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(ErrorCode.BAD_REQUEST, "Request body must be a JSON object.", 400);
    }

    const record = body as Record<string, unknown>;
    const isStructured =
      "endpoint" in record || (typeof record.event === "object" && record.event !== null);

    if (!isStructured) {
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const validationError = validateStructuredPayload(record);
    if (validationError) {
      return errorResponse("VALIDATION_ERROR", validationError, 422);
    }

    const endpoint = normalizeEndpoint(record.endpoint as Record<string, unknown>);
    const event = normalizeEvent(record.event as Record<string, unknown>);
    const idempotencyKey = `${event.id}:${endpoint.id}`;

    const store = getOutboxStore();
    const existing = store.findByIdempotencyKey
      ? store.findByIdempotencyKey(idempotencyKey)
      : store.list().find((e) => e.idempotencyKey === idempotencyKey);

    if (existing) {
      return NextResponse.json(
        { received: true, enqueued: true, outboxId: existing.id, duplicate: true },
        { status: 202 },
      );
    }

    const entry = appendToOutbox({ endpoint, event, idempotencyKey });
    return NextResponse.json(
      { received: true, enqueued: true, outboxId: entry.id, duplicate: false },
      { status: 202 },
    );
  } catch {
    return errorResponse(
      ErrorCode.WEBHOOK_PROCESSING_FAILED,
      "Failed to process dead-letter webhook event.",
      500,
    );
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function authenticatePost(request: Request): Promise<NextResponse | null> {
  const internalResult = await requireInternalServiceAuth(request, {
    concealFailure: false,
  });
  if (!(internalResult instanceof NextResponse)) {
    return null;
  }

  const jwtIdentity = tryAuthenticateRequest(request);
  if (jwtIdentity) {
    if (jwtIdentity.role === "admin") {
      return null;
    }
    return errorResponse(ErrorCode.FORBIDDEN, "Admin role required.", 403);
  }

  if (internalResult.status === 401) {
    return internalResult;
  }
  return errorResponse(ErrorCode.UNAUTHORIZED, "Authentication required.", 401);
}

// ── Validation & SSRF helpers ─────────────────────────────────────────────────

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isSafeWebhookUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  // IPv4 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return !isPrivateOrLoopbackIPv4(host);
  }

  // IPv6 literal
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") {
      return false;
    }
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
      return false;
    }
    const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) {
      return !isPrivateOrLoopbackIPv4(mapped[1]);
    }
    // Hex-encoded IPv4-mapped IPv6 (e.g. ::ffff:7f00:1)
    if (host.startsWith("::ffff:")) {
      return false;
    }
  }

  return true;
}

function validateStructuredPayload(record: Record<string, unknown>): string | null {
  if (!isPlainObject(record.endpoint)) {
    return "Missing or invalid required field: endpoint.";
  }
  const ep = record.endpoint;
  if (!isNonEmptyString(ep.id)) {
    return "Missing or invalid required field: endpoint.id.";
  }
  if (!isNonEmptyString(ep.url)) {
    return "Missing or invalid required field: endpoint.url.";
  }
  if (!isSafeWebhookUrl(ep.url)) {
    return "Invalid field endpoint.url: must be a public HTTP(S) URL.";
  }
  if (typeof ep.maxRetries !== "number" || !Number.isFinite(ep.maxRetries) || ep.maxRetries < 0) {
    return "Missing or invalid required field: endpoint.maxRetries (must be a non-negative number).";
  }

  if (!isPlainObject(record.event)) {
    return "Missing or invalid required field: event.";
  }
  const ev = record.event;
  if (!isNonEmptyString(ev.id)) {
    return "Missing or invalid required field: event.id.";
  }
  if (!isNonEmptyString(ev.eventType)) {
    return "Missing or invalid required field: event.eventType.";
  }
  if (!isNonEmptyString(ev.streamId)) {
    return "Missing or invalid required field: event.streamId.";
  }
  if (
    !isNonEmptyString(ev.timestamp) ||
    !ISO_8601_RE.test(ev.timestamp) ||
    Number.isNaN(Date.parse(ev.timestamp))
  ) {
    return "Missing or invalid required field: event.timestamp (must be an ISO-8601 string).";
  }
  if (ev.data !== undefined && !isPlainObject(ev.data)) {
    return "Invalid field event.data: must be a JSON object.";
  }

  return null;
}

function normalizeEndpoint(ep: Record<string, unknown>): WebhookEndpoint {
  return {
    id: ep.id as string,
    url: ep.url as string,
    maxRetries: ep.maxRetries as number,
    ...(typeof ep.secret === "string" ? { secret: ep.secret } : {}),
    ...(Array.isArray(ep.previousSecrets)
      ? { previousSecrets: ep.previousSecrets.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(typeof ep.circuitBreakerThreshold === "number"
      ? { circuitBreakerThreshold: ep.circuitBreakerThreshold }
      : {}),
  };
}

function normalizeEvent(ev: Record<string, unknown>): WebhookEvent {
  return {
    id: ev.id as string,
    eventType: ev.eventType as string,
    streamId: ev.streamId as string,
    timestamp: ev.timestamp as string,
    data: isPlainObject(ev.data) ? ev.data : {},
  };
}
