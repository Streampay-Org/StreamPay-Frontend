import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { ProjectionError, toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";
import { deleteStream } from "@/app/lib/stream-delete";
import { streamCache } from "@/app/lib/cache";
import { inferStreamChangeAction, publishStreamChange } from "@/app/lib/stream-publish";
import type { Stream } from "@/app/types/openapi";

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
  if (!stream || stream.deletedAt) {
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

  let streamV2;
  try {
    streamV2 = toV2Stream(dbStreamToV1(stream));
  } catch (err) {
    if (err instanceof ProjectionError) {
      return errorResponse("PROJECTION_ERROR", err.message, 500);
    }
    throw err;
  }
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
export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  const actor = await resolveV2Actor(request);
  const tenant = await resolveV2Tenant(request);
  const result = await deleteStream(id, actor, tenant);
  if (result.status === 204) {
    streamCache.invalidate(id);
    return new NextResponse(null, { status: 204 });
  }
  return errorResponse(result.code, result.message, result.status);
}

async function resolveV2Actor(request: Request): Promise<string | null> {
  const actor = request.headers.get("x-actor-address") ?? request.headers.get("x-stellar-address");
  return actor && actor.trim().length > 0 ? actor.trim() : null;
}

async function resolveV2Tenant(request: Request): Promise<string | null> {
  const tenant = request.headers.get("x-tenant-id");
  return tenant && tenant.trim().length > 0 ? tenant.trim() : null;
}

/** PATCH /api/v2/streams/:id */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const { streamRepository } = getStore();
  const params = await context.params;
  const id = params.id;
  const stream = streamRepository.streams.get(id);
  if (!stream || stream.deletedAt) {
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
  streamRepository.streams.set(id, updated as unknown as Stream);

  publishStreamChange({
    action: inferStreamChangeAction(stream, updated as Stream),
    actor: request.headers.get("Actor-Wallet-Address") ?? undefined,
    after: updated as Stream,
    before: stream,
    correlationId: getCorrelationContext()?.correlation_id,
  });

  const streamV2 = toV2Stream(dbStreamToV1(updated as unknown as Stream));
  return NextResponse.json({
    ...streamV2,
    data: streamV2,
  });
}
