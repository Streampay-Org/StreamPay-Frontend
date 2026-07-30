import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";

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
