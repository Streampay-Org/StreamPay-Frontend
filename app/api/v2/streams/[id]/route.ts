import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";

type Context = { params: Promise<{ id: string }> };

async function enforceRateLimit(request: Request, method: "GET" | "DELETE") {
  const url = new URL(request.url);
  const limitType = getLimitForRoute(method, url.pathname);
  const identity = getClientIdentity(request);
  const result = await checkRateLimit(identity, limitType);
  if (!result.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(result.retryAfter!);
  }
  recordRequest(url.pathname);
  return null;
}

function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** GET /api/v2/streams/:id — single stream in v2 shape. */
export async function GET(request: Request, { params }: Context) {
  const rateLimited = await enforceRateLimit(request, "GET");
  if (rateLimited) return rateLimited;

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

  const response = NextResponse.json({
    data: toV2Stream(dbStreamToV1(stream)),
    links: { self: `/api/v2/streams/${id}` },
  });

  // Attach ETag and Cache-Control headers to the 200 OK response
  response.headers.set("etag", etag);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  return response;
}

/** DELETE /api/v2/streams/:id */
export async function DELETE(request: Request, { params }: Context) {
  const rateLimited = await enforceRateLimit(request, "DELETE");
  if (rateLimited) return rateLimited;

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
