import { NextRequest, NextResponse } from "next/server";
import { registry, webhookCounter, webhookDuration } from "@/src/metrics/registry";
import { logger } from "@/app/lib/logger";
import { webhookPayloadSchema } from "@/src/validators/webhooks";

// Prometheus metrics endpoint
export async function GET(request: Request) {
  // Per-user rate limit — identity: API key > JWT wallet sub > IP.
  const rateLimited = await applyRateLimit(request, 'webhooks', 'GET');
  if (rateLimited) return rateLimited;

  try {
    const metrics = await registry.metrics();
    return new NextResponse(metrics, {
      status: 200,
      headers: {
        "Content-Type": registry.contentType,
      },
    });
  } catch (error) {
    logger.error("Failed to generate metrics", { error });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// Webhook receiver endpoint
export async function POST(req: NextRequest) {
  // Per-user rate limit before body parse / processing so exhausted callers
  // cannot spend CPU on validation or metrics work.
  const rateLimited = await applyRateLimit(req, 'webhooks', 'POST');
  if (rateLimited) return rateLimited;

  const start = process.hrtime();
  let status = 200;
  let eventType = "unknown";

  try {
    let body: unknown;

    try {
      body = await req.json();
    } catch (error) {
      status = 400;
      logger.info("Rejected webhook request with invalid JSON", { error });
      return NextResponse.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Request body must be valid JSON.",
          },
        },
        { status },
      );
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

    return NextResponse.json({ success: true }, { status });
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
