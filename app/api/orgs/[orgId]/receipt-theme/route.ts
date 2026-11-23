import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auditLogStore } from "@/app/lib/audit-log";
import { ActorMismatchError, resolveActorAddress } from "@/app/lib/org-policy";
import { orgDb, setOrgReceiptTheme } from "@/app/lib/org-db";
import {
  normalizeReceiptTheme,
  RECEIPT_LOGO_ALLOWED_HOSTS_ENV,
  validateReceiptTheme,
  type ReceiptTheme,
  type ReceiptThemeInput,
} from "@/app/lib/receipt-theme";
import type { OrgRecord } from "@/app/lib/org-types";

type Context = { params: Promise<{ orgId: string }> };

function error(code: string, message: string, status: number, fields?: Record<string, string>) {
  return NextResponse.json(
    { error: { code, message, request_id: randomUUID(), fields } },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

function authorize(request: Request, orgId: string, ownerOnly = false) {
  const org = orgDb.orgs.get(orgId);
  if (!org) return error("ORG_NOT_FOUND", "Organization not found.", 404);

  let actor: string | null;
  try {
    actor = resolveActorAddress(request);
  } catch (cause) {
    if (cause instanceof ActorMismatchError) {
      return error("ACTOR_MISMATCH", "The signed wallet does not match the supplied address.", 403);
    }
    throw cause;
  }
  const member = org.members.find(({ walletAddress }) => walletAddress === actor);
  if (!member || (ownerOnly && member.role !== "owner")) {
    return error(
      "FORBIDDEN",
      ownerOnly ? "Only organization owners may change receipt themes." : "Organization membership is required.",
      403,
    );
  }

  return { org, member };
}

function themeResponse(orgId: string, theme: ReceiptTheme | undefined, canEdit: boolean) {
  return NextResponse.json(
    {
      data: {
        orgId,
        theme: theme ?? null,
        canEdit,
        logoAllowedHosts: process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] ?? "",
      },
      links: { self: `/api/orgs/${orgId}/receipt-theme` },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function updateTheme(request: Request, org: OrgRecord, actor: string, theme?: ReceiptTheme) {
  const previous = org.receiptTheme;
  if (
    previous?.accentColor !== theme?.accentColor ||
    previous?.logoUrl !== theme?.logoUrl ||
    previous?.message !== theme?.message
  ) {
    auditLogStore.append({
      actor: { id: actor, role: "user" },
      target: { type: "account", id: org.id },
      action: theme ? "org.receipt_theme.updated" : "org.receipt_theme.reset",
      before: previous ?? null,
      after: theme ?? null,
      requestId: request.headers.get("x-request-id") || randomUUID(),
      metadata: { orgId: org.id },
    });
    setOrgReceiptTheme(org.id, theme);
  }
  return themeResponse(org.id, theme, true);
}

export async function GET(request: Request, { params }: Context) {
  const { orgId } = await params;
  const access = authorize(request, orgId);
  if (access instanceof NextResponse) return access;
  return themeResponse(orgId, access.org.receiptTheme, access.member.role === "owner");
}

export async function PUT(request: Request, { params }: Context) {
  const { orgId } = await params;
  const access = authorize(request, orgId, true);
  if (access instanceof NextResponse) return access;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return error("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  // Recheck access and read the latest org after the asynchronous body read.
  const current = authorize(request, orgId, true);
  if (current instanceof NextResponse) return current;
  const fields = validateReceiptTheme(input);
  if (Object.keys(fields).length) {
    return error("VALIDATION_ERROR", "Check the receipt theme fields.", 422, fields);
  }

  return updateTheme(request, current.org, current.member.walletAddress, normalizeReceiptTheme(input as ReceiptThemeInput));
}

export async function DELETE(request: Request, { params }: Context) {
  const { orgId } = await params;
  const access = authorize(request, orgId, true);
  if (access instanceof NextResponse) return access;
  return updateTheme(request, access.org, access.member.walletAddress);
}
