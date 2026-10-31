/**
 * GET  /api/streams/template        - List all templates
 * POST /api/streams/template        - Create a new template
 * GET  /api/streams/template/[id]   - Get a specific template (handled in [id]/route.ts)
 */

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { parseTemplateAmount } from "@/app/lib/amount";
import { errorResponse } from "@/app/lib/errors/server";
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

import { listTemplates, createTemplate, type StreamTemplate } from "@/app/lib/repositories/templates";
export type { StreamTemplate } from "@/app/lib/repositories/templates";

export async function GET() {
  return NextResponse.json({ templates: listTemplates() });
}

export async function POST(request: Request) {
  let body: Partial<StreamTemplate>;
  try {
    const limits = buildLimitsConfig();
    const maxBytes =
      getBodySizeLimit(extractPathname(request), limits) ?? limits.default;
    body = await readJsonBody<Partial<StreamTemplate>>(request, { maxBytes });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return createBodySizeTooLargeResponse(
        error.receivedBytes,
        error.maxBytes,
        resolveRequestId(request.headers),
      );
    }
    if (error instanceof InvalidJsonError) {
      return await errorResponse(
        error.code,
        error.code === "EMPTY_BODY"
          ? "Request body is required"
          : "Request body must be valid JSON",
        400,
      );
    }
    throw error;
  }

  // Validation precedence: name -> asset -> amountPerInterval -> intervalSeconds
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return await errorResponse("MISSING_NAME", "Template name is required", 422);
  }
  if (!body.asset || typeof body.asset !== "string" || body.asset.trim().length === 0) {
    return await errorResponse("MISSING_ASSET", "asset is required", 422);
  }

  const amountValidation = parseTemplateAmount(body.amountPerInterval);
  if (!amountValidation.ok) {
    return await errorResponse(amountValidation.code, amountValidation.message, 422);
  }

  const rawInterval = body.intervalSeconds;
  const isInteger =
    typeof rawInterval === "number"
      ? Number.isInteger(rawInterval)
      : typeof rawInterval === "string" && /^\d+$/.test(rawInterval.trim());
  const intervalNum = Number(rawInterval);

  if (
    !isInteger ||
    !Number.isFinite(intervalNum) ||
    intervalNum < 60 ||
    intervalNum > 31_536_000
  ) {
    return await errorResponse(
      "INVALID_INTERVAL",
      "intervalSeconds must be an integer between 60 and 31536000",
      422,
    );
  }

  const template: StreamTemplate = {
    id: `tpl_${randomUUID()}`,
    name: body.name.trim(),
    asset: body.asset.trim(),
    amountPerInterval: amountValidation.value,
    intervalSeconds: intervalNum,
    memo: body.memo,
    createdAt: new Date().toISOString(),
  };

  createTemplate(template);
  return NextResponse.json({ template }, { status: 201 });
}

