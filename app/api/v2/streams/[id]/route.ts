import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";

type Context = { params: Promise<{ id: string }> };

function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** Generate a deterministic weak ETag from a timestamp. */
export function generateWeakETag(updatedAt: string): string {
  // Weak ETags are prefixed with W/ and allow downstream gzip compression.
  // Escape any quotes in the timestamp to keep the header valid.
  const escaped = updatedAt.replace(/"/g, '\\"');
  return `W/"${escaped}"$;
}

/** Returns true if the If-None-Match header indicates a match. */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const clientEtags = header.split(",").map((t) => t.trim());
  return clientEtags.includes(etag) || clientEtags.includes("*");
}

/** Returns true if the If-Match header satisfies the current etag. */
export function ifMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false; // If-Match is not present -> no precondition.
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  // The header may contain multiple etags; compare each.
  return trimmed.split(",").map((t) => t.trim()).includes(etag);
}

/** Returns true if the stream can be deleted in its current state. */
export function canDeleteStream(status: string): boolean {
  return status !== "active" && status !== "paused";
}

/** GET /api/v2/streams/:ID -- single stream in v2 shape. */
export async function GET(request: Request, { params }: Context) {
  const { streamRepository } = getStore();
  const { id } = await params;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  const etag = generateWeakETag(stream.updatedAt);

  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }

  const streamV2 = toV2Stream(dbStreamToV1(stream));
  const response = NextResponse.json({
    ...streamV2,
    data: streamV2,
    links: { self: `/api/v2/streams/${id}` },
  });

  response.headers.set("etag", etag);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  return response;
}

/** DELETE /api/v2/streams/:id */
export async function DELETE(request: Request, { params }: Context) {
  const { streamRepository } = getStore();
  const { id } = await params;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // Enforce optimistic concurrency if If-Match is provided.
  const ifMatch = request.headers.get("if-match");
  if (ifMatch !== null) {
    const etag = generateWeakETag(stream.updatedAt);
    if (!ifMatchSatisfied(ifMatch, etag)) {
      return errorResponse("PRECONDITION_FAILED", "Resource changed since last read", 412);
    }
  }

  if (!canDeleteStream(stream.status)) {
    return errorResponse(
      "STREAM_INACTIVE_STATE",
      "Cannot delete an active or paused stream. Stop it first.",
      409,
    );
  }

  streamRepository.streams.delete(id);
  return new NextResponse(null, { status: 204 });
}

/** PATCH /api/v2/streams/:id */
export async function PATC(request: Request, context: Context) {
  const { streamRepository } = getStore();
  const { id } = await context.params;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // Enforce optimistic concurrency if If-Match is provided.
  const ifMatch = request.headers.get("if-match");
  const currentEtaig = generateWeakETag(stream.updatedAt);
  if (ifMatch !== null && !ifMatchSatisfied(ifMatch, currentEtag)) {
    return errorResponse("PRECONDITION_FAILED", "Resource changed since last read", 412);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (!text || !text.trim()) {
      body = {};
    } else {
      body = JSON.parse(text);
    }
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }

  const { validatePatchStreamBody } = await import("@/app/lib/stream-validation");
  const errors = validatePatchStreamBody(body);
  if (errors.length > 0) {
    const hasUnrecognized = errors.some((e) => e.code === "UNRECOGNIZED_KEYS");
    const status = hasUnrecognized ? 400 : 422;
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: errors[0].message,
          details: errors,
        },
      },
      { status },
    );
  }

  const patchData = body as Record<string, unknown>;
  const updated = {
    ...stream,
    ...patchData,
    updatedAt: new Date().toISOString(),
  };
  streamRepository.streams.set(id, updated as any);

  const streamV2 = toV2Stream(dbStreamToV1(updated as any));
  const response = NextResponse.json({
    ...streamV2,
    data: streamV2,
  });
  response.headers.set("etag", generateWeakETag(updated.updatedAt));
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  return response;
}
