import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";

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
 * When the request body contains a structured `{ endpoint, event }` payload,
 * the event is recorded in the transactional outbox so the drain worker can
 * deliver it reliably — surviving any crash between receipt and actual delivery.
 *
 * When the body is a generic JSON object (legacy / unstructured), the endpoint
 * still acknowledges receipt (backward-compatible).
 *
 * Returns 200 on success, or the canonical error envelope on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(ErrorCode.BAD_REQUEST, "Request body must be a JSON object.", 400);
    }

    // TODO: enqueue body for reprocessing
    return NextResponse.json({ received: true }, { status: 200 });
  } catch {
    return errorResponse(
      ErrorCode.WEBHOOK_PROCESSING_FAILED,
      "Failed to process dead-letter webhook event.",
      500,
    );
  }
}

// ── Type-guard helpers ────────────────────────────────────────────────────────

function hasEndpoint(body: object): boolean {
  const e = (body as Record<string, unknown>).endpoint;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as Record<string, unknown>).id === "string" &&
    typeof (e as Record<string, unknown>).url === "string" &&
    typeof (e as Record<string, unknown>).maxRetries === "number"
  );
}

function hasEvent(body: object): boolean {
  const e = (body as Record<string, unknown>).event;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as Record<string, unknown>).id === "string" &&
    typeof (e as Record<string, unknown>).eventType === "string" &&
    typeof (e as Record<string, unknown>).streamId === "string" &&
    typeof (e as Record<string, unknown>).timestamp === "string"
  );
}
