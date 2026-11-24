import { NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";

/**
 * POST /api/debug/kms-sign
 *
 * Debug endpoint: signs an arbitrary payload via KMS.
 * Only available in non-production environments.
 *
 * Body: { "payload": "<base64-encoded string>" }
 * Response: { "signature": "<base64-encoded signature>" }
 */
export async function POST(request: Request) {
  // Hard-disable in production
  if (process.env.NODE_ENV === 'production') {
    return errorResponse(ErrorCode.NOT_FOUND, "Route not found.", 404);
  }

  // Internal-service auth (concealFailure hides auth failures as 404)
  const authResult = await requireInternalServiceAuth(request, { concealFailure: true });
  if (authResult instanceof NextResponse) {
    return errorResponse(ErrorCode.NOT_FOUND, "Route not found.", 404);
  }

  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body.payload !== "string" || body.payload.trim() === "") {
      return errorResponse(
        ErrorCode.KMS_SIGN_INVALID_INPUT,
        "Request body must include a non-empty 'payload' string.",
        400,
      );
    }

    // TODO: call KMS signing service
    const signature = Buffer.from(`signed:${body.payload}`).toString("base64");

    return Response.json({ signature }, { status: 200 });
  } catch {
    return errorResponse(
      ErrorCode.KMS_SIGN_FAILED,
      "KMS signing operation failed.",
      500,
    );
  }
}
