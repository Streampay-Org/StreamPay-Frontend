/**
 * Deprecated compatibility alias for POST /api/streams/preview.
 */

import { NextResponse } from "next/server";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamPreviewRateLimit } from "@/app/lib/stream-preview-rate-limit";
import { createStreamPreviewResponse } from "@/app/lib/stream-preview";

const SCHEDULE_BY_SECONDS: Record<number, string> = {
  1: "second",
  60: "minute",
  3_600: "hour",
  86_400: "day",
  604_800: "week",
  2_592_000: "month",
  31_536_000: "year",
};

const DEPRECATION_HEADERS = {
  Deprecation: "@1792368000",
  Sunset: "Tue, 19 Oct 2027 00:00:00 GMT",
};

function deprecatedResponse(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(DEPRECATION_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function unsupportedIntervalResponse(): NextResponse {
  const requestId = getCorrelationContext()?.request_id;
  return NextResponse.json(
    {
      data: {
        valid: false,
        estimated_events: [],
        cost_estimate: null,
        preview_stream: null,
      },
      error: {
        code: "UNSUPPORTED_INTERVAL",
        message: "intervalSeconds must exactly match a supported stream schedule.",
        request_id: requestId,
      },
    },
    { status: 422, headers: DEPRECATION_HEADERS },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await checkStreamPreviewRateLimit(request);
  if (limited) return deprecatedResponse(limited);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return deprecatedResponse(
      NextResponse.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Request body must be valid JSON",
            request_id: getCorrelationContext()?.request_id,
          },
        },
        { status: 400 },
      ),
    );
  }

  const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const intervalSeconds = body.intervalSeconds;
  const schedule = typeof intervalSeconds === "number"
    ? SCHEDULE_BY_SECONDS[intervalSeconds]
    : undefined;

  if (!schedule) return unsupportedIntervalResponse();

  const rate = body.amountPerInterval;
  const token = body.asset;
  return deprecatedResponse(
    await createStreamPreviewResponse({
      recipient: body.recipient,
      rate: typeof rate === "string" || typeof rate === "number" ? String(rate) : rate,
      schedule,
      token,
    }),
  );
}
