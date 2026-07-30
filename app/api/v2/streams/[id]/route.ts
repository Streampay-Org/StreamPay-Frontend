import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";

type Context = { params: Promise<{ id: string }> };

function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** GET /api/v2/streams/:id — single stream in v2 shape. */
export async function GET(request: Request, { params }: Context) {
  const { streamRepository } = getStore();
  const { id } = await params;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // Generate a weak ETag based on the stream's updatedAt timestamp
  // Weak ETags are prefixed with W/ and allow downstream gzip compression
  const etag = `W/"${stream.updatedAt}"`;

  // Parse and match the If-None-Match request header
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const clientEtags = ifNoneMatch.split(",").map((t) => t.trim());
    if (clientEtags.includes(etag) || clientEtags.includes("*")) {
      // Short-circuit returning 304 Not Modified
      return new NextResponse(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    }
  }

  const streamV2 = toV2Stream(dbStreamToV1(stream));
  const response = NextResponse.json({
    ...streamV2,
    data: streamV2,
    links: { self: `/api/v2/streams/${id}` },
  });

  // Attach ETag and Cache-Control headers to the 200 OK response
  response.headers.set("etag", etag);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  return response;
}

/** DELETE /api/v2/streams/:id */
export async function DELETE(_request: Request, { params }: Context) {
  const { streamRepository } = getStore();
  const { id } = await params;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }
  if (stream.status === "active" || stream.status === "paused") {
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
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const { streamRepository } = getStore();
  const params = await context.params;
  const id = params.id;
  const stream = streamRepository.streams.get(id);
  if (!stream) {
    return errorResponse("NOT_FOUND", `Stream '${id}' not found`, 404);
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
  return NextResponse.json({
    ...streamV2,
    data: streamV2,
  });
}
