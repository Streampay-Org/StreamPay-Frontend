/**
 * POST /api/streams/preview
 *
 * Runs the stream creation validation and allowlist pipeline without writing
 * to the stream or idempotency stores.
 */

import { NextResponse } from "next/server";
import { checkStreamPreviewRateLimit } from "@/app/lib/stream-preview-rate-limit";
import { createStreamPreviewResponse } from "@/app/lib/stream-preview";

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await checkStreamPreviewRateLimit(request);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Request body must be valid JSON",
        },
      },
      { status: 400 },
    );
  }

  return createStreamPreviewResponse(body);
}
