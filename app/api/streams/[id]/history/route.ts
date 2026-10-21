/**
 * GET /api/streams/:id/history
 *
 * Paginated, newest-first list of committed lifecycle events for a stream.
 * Uses a composite (at, id) cursor. Visibility rules match GET /api/streams/:id.
 *
 * Query parameters:
 *   limit  — integer 1-100, default 20
 *   cursor — opaque string from meta.nextCursor
 *
 * Error codes:
 *   400  MISSING_TENANT    — x-tenant-id header absent or blank
 *   404  STREAM_NOT_FOUND  — stream not in this tenant
 *   422  VALIDATION_ERROR  — limit out of range
 */

import { NextResponse } from "next/server";
import { db, getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function errorResponse(code: string, message: string, status: number) {
  const ctx = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: ctx?.request_id } },
    { status },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Require tenant header (same contract as GET /api/streams/:id).
  const tenant = request.headers.get("x-tenant-id");
  if (!tenant || tenant.trim() === "") {
    return errorResponse("MISSING_TENANT", "Tenant ID header (x-tenant-id) is required", 400);
  }

  // Tenant-scoped stream lookup — returns null when stream belongs to another tenant.
  const stream = db.streams.findOne ? db.streams.findOne(tenant, id) : null;
  if (!stream) {
    return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // Parse query parameters.
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    url = new URL(`http://localhost/api/streams/${id}/history`);
  }

  const rawLimit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return errorResponse(
        "VALIDATION_ERROR",
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        422,
      );
    }
    limit = parsed;
  }

  const { data, meta } = getStore().streamHistory.query({ streamId: id, cursor, limit });
  return NextResponse.json({ data, meta });
}
