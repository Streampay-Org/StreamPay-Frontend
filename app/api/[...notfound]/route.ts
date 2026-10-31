import { errorResponse } from "@/app/lib/errors/server";
import { resolveRequestId } from "@/lib/requestId";

function handler(request: Request) {
  let path = "/api";
  try { path = new URL(request.url).pathname; } catch { /* Keep the safe fallback. */ }
  return errorResponse("NOT_FOUND", "Unknown API path: " + path, 404, undefined, {
    requestId: resolveRequestId(request.headers),
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export function HEAD(request: Request) {
  const response = handler(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
