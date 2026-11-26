import { NextResponse } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { processDeletionRequest } from "@/app/lib/privacy";
import { resolveRequestId, REQUEST_ID_HEADER } from "@/lib/requestId";

function createErrorResponse(
  request: Request,
  code: string,
  message: string,
  status: number,
) {
  const requestId = resolveRequestId(request.headers);
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    {
      status,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

/**
 * DELETE /api/identity/me/delete
 * Trigger a Data Subject Request (DSR) for account deletion.
 */
export async function DELETE(request: Request) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return createErrorResponse(
      request,
      "UNAUTHORIZED",
      "Missing or invalid authorization header",
      401,
    );
  }

  try {
    const result = await processDeletionRequest(actor.walletAddress);

    return NextResponse.json(
      {
        data: {
          ...result,
          message:
            "Your deletion request has been received and is being processed. All PII will be scrubbed within 30 days.",
          completion_estimate: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      },
      { status: 202 },
    );
  } catch {
    return createErrorResponse(
      request,
      "INTERNAL_ERROR",
      "Failed to process deletion request",
      500,
    );
  }
}
