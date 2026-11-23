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
} from "@/lib/readJsonBody";
import { resolveRequestId } from "@/lib/requestId";
import { verifyWebhookSignature } from "@/app/lib/webhook-delivery";
import { getActiveSigningSecrets } from "@/app/lib/webhook-secrets";
import { getWebhookInboundStore } from "@/app/lib/webhook-inbound-store";
import { dispatchWebhook } from "@/app/lib/webhook-handlers";

const DEFAULT_REPLAY_TOLERANCE_MS = 300_000;

function getReplayToleranceMs(): number {
  const raw = process.env.WEBHOOK_REPLAY_TOLERANCE_MS;
  if (!raw) return DEFAULT_REPLAY_TOLERANCE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REPLAY_TOLERANCE_MS;
  }
  return Math.floor(parsed);
}

function parseWebhookTimestampMs(timestamp: string): number | null {
  if (!/^\d+$/.test(timestamp)) {
    return null;
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  return seconds * 1000;
}

/**
 * Reads the raw UTF-8 request body while enforcing `maxBytes`, returning both
 * the exact raw string (needed for HMAC signature verification) and parsed JSON.
 */
async function readRawWebhookBody(
  request: Pick<Request, "body">,
  maxBytes: number,
): Promise<{ rawBody: string; parsedBody: unknown }> {
  const limit = Math.floor(maxBytes);
  const body = request.body;
  if (!body) {
    throw new InvalidJsonError("EMPTY_BODY");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors on already-closed streams.
        }
        throw new BodyTooLargeError(limit, receivedBytes);
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw error;
    }
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body could not be read.",
      { cause: error },
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures.
    }
  }

  if (receivedBytes === 0) {
    throw new InvalidJsonError("EMPTY_BODY");
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let rawBody: string;
  try {
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body must be valid UTF-8.",
      { cause },
    );
  }

  try {
    return { rawBody, parsedBody: JSON.parse(rawBody) };
  } catch (cause) {
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body must be valid JSON.",
      { cause },
    );
  }
}

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
    let rawBody: string;
    let body: unknown;

    try {
      const limits = buildLimitsConfig();
      const maxBytes =
        getBodySizeLimit(extractPathname(req), limits) ?? limits.webhook;
      const result = await readRawWebhookBody(req, maxBytes);
      rawBody = result.rawBody;
      body = result.parsedBody;
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

    // Verify HMAC signature & replay window
    const headers = req.headers ?? new Headers();
    const signatureHeader = headers.get("x-streampay-signature")?.trim() ?? "";
    const timestampHeader = headers.get("x-streampay-timestamp")?.trim() ?? "";
    const eventId =
      parsed.data.eventId ??
      headers.get("x-streampay-event-id")?.trim() ??
      headers.get("x-streampay-delivery-id")?.trim() ??
      "";

    if (!signatureHeader || !timestampHeader || !eventId) {
      status = 401;
      logger.info("Rejected webhook request with missing signature headers", {
        eventType,
        hasSignature: Boolean(signatureHeader),
        hasTimestamp: Boolean(timestampHeader),
        hasEventId: Boolean(eventId),
      });
      return NextResponse.json(
        {
          error: {
            code: "INVALID_SIGNATURE",
            message: "Missing or invalid webhook signature.",
          },
        },
        { status },
      );
    }

    const requestTimeMs = parseWebhookTimestampMs(timestampHeader);
    if (requestTimeMs === null) {
      status = 401;
      logger.info("Rejected webhook request with malformed timestamp", {
        eventType,
        eventId,
      });
      return NextResponse.json(
        {
          error: {
            code: "INVALID_SIGNATURE",
            message: "Invalid webhook timestamp.",
          },
        },
        { status },
      );
    }

    const toleranceMs = getReplayToleranceMs();
    if (Math.abs(Date.now() - requestTimeMs) > toleranceMs) {
      status = 401;
      logger.info("Rejected webhook request outside replay window", {
        eventType,
        eventId,
        toleranceMs,
      });
      return NextResponse.json(
        {
          error: {
            code: "REPLAY_WINDOW_EXCEEDED",
            message: "Webhook timestamp is outside the allowed replay window.",
          },
        },
        { status },
      );
    }

    const secrets = getActiveSigningSecrets();
    const isSignatureValid = verifyWebhookSignature(
      rawBody,
      secrets,
      signatureHeader,
      timestampHeader,
      eventId,
      toleranceMs,
    );

    if (!isSignatureValid) {
      status = 401;
      logger.info("Rejected webhook request with invalid signature", {
        eventType,
        eventId,
      });
      return NextResponse.json(
        {
          error: {
            code: "INVALID_SIGNATURE",
            message: "Invalid webhook signature.",
          },
        },
        { status },
      );
    }

    // Deduplicate by eventId (atomic check-and-mark to handle concurrent duplicates)
    const inboundStore = getWebhookInboundStore();
    const acquired = await inboundStore.tryMarkSeen(eventId);
    if (!acquired) {
      status = 200;
      logger.info("Ignored duplicate webhook event", { eventType, eventId });
      return withRateLimitHeaders(
        NextResponse.json({ success: true, duplicate: true }, { status }),
        rateLimitResult.headers,
      );
    }

    // Dispatch to typed handler registry; unmark on handler failure so sender can retry
    try {
      const dispatchResult = await dispatchWebhook(parsed.data);
      if (!dispatchResult.handled) {
        status = 202;
        logger.info("Accepted unhandled webhook event type", { eventType, eventId });
        return withRateLimitHeaders(
          NextResponse.json({ success: true, handled: false }, { status }),
          rateLimitResult.headers,
        );
      }

      status = 200;
      return withRateLimitHeaders(
        NextResponse.json({ success: true }, { status }),
        rateLimitResult.headers,
      );
    } catch (dispatchError) {
      await inboundStore.unmark(eventId);
      throw dispatchError;
    }
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
