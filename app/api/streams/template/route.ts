/**
 * GET  /api/streams/template        - List all templates
 * POST /api/streams/template        - Create a new template
 * GET  /api/streams/template/[id]   - Get a specific template (handled in [id]/route.ts)
 */

import { NextResponse } from "next/server";
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

interface StreamTemplate {
  id: string;
  name: string;
  asset: string;
  amountPerInterval: number;
  intervalSeconds: number;
  memo?: string;
  createdAt: string;
}

// Seeded demo presets so the templates gallery is populated without a database.
const SEED_TEMPLATES: StreamTemplate[] = [
  { id: "tpl_design_retainer", name: "Monthly Design Retainer", asset: "XLM", amountPerInterval: 120, intervalSeconds: 2592000, memo: "Recurring freelance payment for an ongoing design engagement", createdAt: "2026-01-15T00:00:00.000Z" },
  { id: "tpl_contractor_income", name: "Weekly Contractor Income", asset: "USDC", amountPerInterval: 800, intervalSeconds: 604800, memo: "Salary-style weekly payout for a contractor", createdAt: "2026-02-10T00:00:00.000Z" },
  { id: "tpl_hosting_bill", name: "Hosting Bill", asset: "USDC", amountPerInterval: 45, intervalSeconds: 2592000, memo: "Monthly infrastructure bill payment to a vendor", createdAt: "2026-03-05T00:00:00.000Z" },
  { id: "tpl_savings_roundup", name: "Daily Savings Roundup", asset: "XLM", amountPerInterval: 5, intervalSeconds: 86400, memo: "Move a little into savings every day", createdAt: "2026-04-20T00:00:00.000Z" },
  { id: "tpl_grant_tranche", name: "Grant Milestone Stream", asset: "XLM", amountPerInterval: 1500, intervalSeconds: 1209600, memo: "Bi-weekly grant tranche for an open-source maintainer", createdAt: "2026-05-02T00:00:00.000Z" },
  { id: "tpl_qa_partnership", name: "QA Partnership", asset: "XLM", amountPerInterval: 64, intervalSeconds: 604800, memo: "Weekly QA support stream", createdAt: "2026-06-11T00:00:00.000Z" },
];

const templates = new Map<string, StreamTemplate>(SEED_TEMPLATES.map((t) => [t.id, t]));

function createErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

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
      return createErrorResponse(
        error.code,
        error.code === "EMPTY_BODY"
          ? "Request body is required"
          : "Request body must be valid JSON",
        400,
      );
    }
    throw error;
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return createErrorResponse("MISSING_NAME", "Template name is required", 400);
  }
  if (!body.asset || typeof body.asset !== "string") {
    return createErrorResponse("MISSING_ASSET", "asset is required", 400);
  }
  if (!body.amountPerInterval || Number(body.amountPerInterval) <= 0) {
    return createErrorResponse("INVALID_AMOUNT", "amountPerInterval must be a positive number", 400);
  }
  if (!body.intervalSeconds || Number(body.intervalSeconds) <= 0) {
    return createErrorResponse("INVALID_INTERVAL", "intervalSeconds must be a positive number", 400);
  }

  const template: StreamTemplate = {
    id: `tpl_${Date.now()}`,
    name: body.name.trim(),
    asset: body.asset,
    amountPerInterval: Number(body.amountPerInterval),
    intervalSeconds: Number(body.intervalSeconds),
    memo: body.memo,
    createdAt: new Date().toISOString(),
  };

  templates.set(template.id, template);
  return NextResponse.json({ template }, { status: 201 });
}
