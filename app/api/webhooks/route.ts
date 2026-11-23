import { NextRequest, NextResponse } from "next/server";
import { registry, webhookCounter, webhookDuration } from "@/src/metrics/registry";
import { logger } from "@/app/lib/logger";
import { webhookPayloadSchema } from "@/src/validators/webhooks";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { applyRateLimit, withRateLimitHeaders } from "@/src/middleware/rateLimit";
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

// Prometheus metrics endpoint
async function handleWebhooksGet(request: Request) {
  // Per-user rate limit — identity: API key > JWT wallet sub > IP.
  const rateLimitResult = await applyRateLimit(request, 'webhooks', 'GET');
  if (!rateLimitResult.allowed) return rateLimitResult.response;

  try {
    const metrics = await registry.metrics();
    return withRateLimitHeaders(
      new NextResponse(metrics, {
        status: 200,
        headers: {
          "Content-Type": registry.contentType,
        },
      }),
      rateLimitResult.headers,
    );
  } catch (error) {
    logger.error("Failed to generate metrics", { error });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleWebhooksGet(request));
}

// Webhook receiver endpoint
async function handleWebhooksPost(req: NextRequest) {
  // Per-user rate limit before body parse / processing so exhausted callers
  // cannot spend CPU on validation or metrics work.
  const rateLimitResult = await applyRateLimit(req, 'webhooks', 'POST');
  if (!rateLimitResult.allowed) return rateLimitResult.response;

  const start = process.hrtime();
  let status = 200;
  let eventType = "unknown";

  try {
    let body: unknown;

    try {
      const limits = buildLimitsConfig();
      const maxBytes =
        getBodySizeLimit(extractPathname(req), limits) ?? limits.webhook;
      body = await readJsonBody(req, { maxBytes });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        status = 413;
        return createBodySizeTooLargeResponse(
          error.receivedBytes,
          error.maxBytes,
          resolveRequestId(req.headers ?? new Headers()),
        );
      }
      if (error instanceof InvalidJsonError) {
        status = 400;
        logger.info("Rejected webhook request with invalid JSON", { error });
        return NextResponse.json(
          {
            error: {
              code: error.code === "EMPTY_BODY" ? "EMPTY_BODY" : "INVALID_INPUT",
              message:
                error.code === "EMPTY_BODY"
                  ? "Request body is required."
                  : "Request body must be valid JSON.",
            },
          },
          { status },
        );
      }
      throw error;
    }

    const parsed = webhookPayloadSchema.safeParse(body);

    if (!parsed.success) {
      status = 400;
      logger.info("Rejected webhook request during schema validation", {
        issues: parsed.error.issues,
      });
      return NextResponse.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: parsed.error.issues[0]?.message ?? "Invalid webhook payload.",
          },
        },
        { status },
      );
    }

    eventType = parsed.data.eventType;

    // TODO: Process webhook body...

    return withRateLimitHeaders(NextResponse.json({ success: true }, { status }), rateLimitResult.headers);
  } catch (error) {
    status = 500;
    logger.error("Webhook processing error", { error });
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal Server Error" } },
      { status },
    );
  } finally {
    const diff = process.hrtime(start);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    webhookCounter.inc({ status: status.toString(), event_type: eventType });
    webhookDuration.observe(
      { status: status.toString(), event_type: eventType },
      durationSeconds,
    );
  }
}

export async function POST(req: NextRequest) {
  return withRouteTimeout(req, () => handleWebhooksPost(req));
}
