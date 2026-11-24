/**
 * Shared JSON body reader for org API routes.
 *
 * Org routes use the same streaming body cap as the rest of the API, but they
 * return the standard org error envelope. Keeping the body-size handling here
 * avoids each handler re-implementing the `readJsonBody` error mapping.
 */

import { NextResponse } from "next/server";
import {
  buildLimitsConfig,
  createBodySizeTooLargeResponse,
  extractPathname,
  getBodySizeLimit,
} from "@/lib/bodySize";
import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
} from "@/lib/readJsonBody";
import { resolveRequestId } from "@/lib/requestId";

export type JsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
) {
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status },
  );
}

export async function readOrgJsonBody<T = unknown>(
  request: Request,
): Promise<JsonBodyResult<T>> {
  const requestId = resolveRequestId(request.headers);

  try {
    const limits = buildLimitsConfig();
    const maxBytes =
      getBodySizeLimit(extractPathname(request), limits) ?? limits.default;
    const body = await readJsonBody<T>(request, { maxBytes });
    return { ok: true, body };
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        ok: false,
        response: createBodySizeTooLargeResponse(
          error.receivedBytes,
          error.maxBytes,
          requestId,
        ),
      };
    }
    if (error instanceof InvalidJsonError) {
      return {
        ok: false,
        response: errorResponse(
          error.code === "EMPTY_BODY" ? "EMPTY_BODY" : "INVALID_REQUEST",
          error.code === "EMPTY_BODY"
            ? "Request body is required."
            : "Request body must be valid JSON.",
          400,
          requestId,
        ),
      };
    }
    throw error;
  }
}
