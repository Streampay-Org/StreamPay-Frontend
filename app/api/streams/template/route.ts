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

export interface StreamTemplate {
  id: string;
  name: string;
  asset: string;
  amountPerInterval: string;
  intervalSeconds: number;
  memo?: string;
  createdAt: string;
}

// Seeded demo presets so the templates gallery is populated without a database.
export const SEED_TEMPLATES: StreamTemplate[] = [
  { id: "tpl_design_retainer", name: "Monthly Design Retainer", asset: "XLM", amountPerInterval: "120", intervalSeconds: 2592000, memo: "Recurring freelance payment for an ongoing design engagement", createdAt: "2026-01-15T00:00:00.000Z" },
  { id: "tpl_contractor_income", name: "Weekly Contractor Income", asset: "USDC", amountPerInterval: "800", intervalSeconds: 604800, memo: "Salary-style weekly payout for a contractor", createdAt: "2026-02-10T00:00:00.000Z" },
  { id: "tpl_hosting_bill", name: "Hosting Bill", asset: "USDC", amountPerInterval: "45", intervalSeconds: 2592000, memo: "Monthly infrastructure bill payment to a vendor", createdAt: "2026-03-05T00:00:00.000Z" },
  { id: "tpl_savings_roundup", name: "Daily Savings Roundup", asset: "XLM", amountPerInterval: "5", intervalSeconds: 86400, memo: "Move a little into savings every day", createdAt: "2026-04-20T00:00:00.000Z" },
  { id: "tpl_grant_tranche", name: "Grant Milestone Stream", asset: "XLM", amountPerInterval: "1500", intervalSeconds: 1209600, memo: "Bi-weekly grant tranche for an open-source maintainer", createdAt: "2026-05-02T00:00:00.000Z" },
  { id: "tpl_qa_partnership", name: "QA Partnership", asset: "XLM", amountPerInterval: "64", intervalSeconds: 604800, memo: "Weekly QA support stream", createdAt: "2026-06-11T00:00:00.000Z" },
];

const templates = new Map<string, StreamTemplate>(SEED_TEMPLATES.map((t) => [t.id, t]));

export async function GET() {
  return NextResponse.json({ templates: Array.from(templates.values()) });
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

  templates.set(template.id, template);
  return NextResponse.json({ template }, { status: 201 });
}

