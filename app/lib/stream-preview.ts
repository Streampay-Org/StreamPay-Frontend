import { NextResponse } from "next/server";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { estimateStreamCost, type PreflightEstimate } from "@/app/lib/preflight-estimate";
import { SUPPORTED_ASSETS } from "@/app/lib/amount";
import { createStreamCore } from "@/app/lib/stream-create-core";

interface EstimatedEvent {
  type: string;
  description: string;
}

interface PreviewStream {
  id: string;
  status: string;
  amount: string;
  asset: string;
  recipient: string;
  sender: string;
  schedule: object;
}

interface PreviewResponseData {
  valid: boolean;
  validation_errors?: { field: string; code: string; message: string }[];
  estimated_events: EstimatedEvent[];
  cost_estimate: PreflightEstimate | null;
  cost_estimate_reason?: string;
  preview_stream: PreviewStream | null;
}

function createErrorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown,
  data?: PreviewResponseData,
) {
  const context = getCorrelationContext();
  return NextResponse.json(
    {
      ...(data ? { data } : {}),
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        request_id: context?.request_id,
      },
    },
    { status },
  );
}

function deriveEstimatedEvents(schedule: string): EstimatedEvent[] {
  const events: EstimatedEvent[] = [
    {
      type: "stream.created",
      description: "The stream record is created on-chain and assigned a unique ID.",
    },
    {
      type: "stream.started",
      description: "The stream transitions to active and begins accumulating payouts.",
    },
    {
      type: "stream.settled",
      description: "Periodic settlement tick moves earned funds into the available balance.",
    },
    {
      type: "stream.ended",
      description: "The stream reaches its end condition or is stopped by the sender.",
    },
  ];

  if (schedule === "second" || schedule === "minute") {
    events.splice(2, 1, {
      type: "stream.settled",
      description: `Periodic settlement tick (${schedule} interval) moves earned funds into the available balance.`,
    });
  }

  return events;
}

export async function createStreamPreviewResponse(body: unknown): Promise<NextResponse> {
  const input = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const result = await createStreamCore(input, { dryRun: true });

  if (!result.ok) {
    if (result.code === "VALIDATION_ERROR") {
      logger.warn("Stream preview validation failed", { errors: result.details });
    }
    const errorData: PreviewResponseData = {
      valid: false,
      ...(result.details ? { validation_errors: result.details } : {}),
      estimated_events: [],
      cost_estimate: null,
      preview_stream: null,
    };
    return createErrorResponse(
      result.code,
      result.message,
      422,
      result.details,
      errorData,
    );
  }

  const stream = result.stream;
  const assetCode = stream.token === "XLM" ? "XLM" : stream.token.split(":")[0];
  const supportedAsset = SUPPORTED_ASSETS.find((asset) => asset === assetCode);
  const costResult = supportedAsset
    ? estimateStreamCost(supportedAsset)
    : null;
  const costEstimate = costResult?.ok ? costResult.value : null;
  const costEstimateReason = costEstimate
    ? undefined
    : supportedAsset
      ? "Cost estimation is unavailable for this asset."
      : `Cost estimation does not support ${assetCode}.`;

  const previewStream: PreviewStream = {
    id: stream.id,
    status: "draft",
    amount: stream.rate,
    asset: stream.token,
    recipient: stream.recipient,
    sender: "pending",
    schedule: { interval: stream.schedule },
  };
  const context = getCorrelationContext();
  const responseBody = {
    data: {
      valid: true,
      estimated_events: deriveEstimatedEvents(stream.schedule),
      cost_estimate: costEstimate,
      ...(costEstimateReason ? { cost_estimate_reason: costEstimateReason } : {}),
      preview_stream: previewStream,
    },
    meta: {
      dry_run: true,
      request_id: context?.request_id ?? crypto.randomUUID(),
    },
  };

  logger.info("Stream preview computed", {
    preview_id: stream.id,
    asset: stream.token,
    schedule: stream.schedule,
  });

  return NextResponse.json(responseBody, { status: 200 });
}
