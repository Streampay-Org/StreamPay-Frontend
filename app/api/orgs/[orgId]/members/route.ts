/**
 * GET    /api/orgs/:orgId/members   — List members
 * POST   /api/orgs/:orgId/members   — Add a member
 * PATCH  /api/orgs/:orgId/members   — Change a member's role
 * DELETE /api/orgs/:orgId/members   — Remove a member
 *
 * Security note: In production, this endpoint must be gated behind JWT
 * verification and only accessible by org owners. The MVP uses
 * `Actor-Wallet-Address` header as a stand-in for the authenticated identity.
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { OrgMember, OrgRecord, OrgRole } from "@/app/lib/org-types";
import {
  extractCorrelationContext,
  getCorrelationContext,
  logger,
  withCorrelationContext,
} from "@/app/lib/logger";
import { readOrgJsonBody } from "@/app/lib/org-request-body";
import { auditLogStore, buildRequestId, resolveAuditActor } from "@/app/lib/audit-log";
import {
  paginateByKeyset,
  parseOrgPaginationParams,
} from "@/app/lib/org-pagination";

const VALID_ROLES: OrgRole[] = ["owner", "pauser", "settler", "viewer"];

function errorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id ?? "mock-request-id" } },
    { status },
  );
}

function orgNotFoundResponse(orgId: string) {
  logger.warn("Org members request rejected: org not found", { org_id: orgId });
  return errorResponse("ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
}

function isOwner(org: OrgRecord, actorAddress: string): boolean {
  return org.members.some(
    (member) => member.walletAddress === actorAddress && member.role === "owner",
  );
}

function countOwners(org: OrgRecord): number {
  return org.members.filter((member) => member.role === "owner").length;
}

function appendMemberAudit(
  request: Request,
  action: string,
  orgId: string,
  walletAddress: string,
  fromRole: OrgRole,
  toRole: OrgRole | null,
) {
  auditLogStore.append({
    action,
    actor: resolveAuditActor(request),
    metadata: { fromRole, orgId, toRole, walletAddress },
    requestId: buildRequestId(request),
    target: { id: `org:${orgId}`, type: "request" },
  });
}

function getRequestUrl(request: Request, fallbackPath: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
  } catch {
    return new URL(`http://localhost${fallbackPath}`);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const correlationContext = extractCorrelationContext(new Headers(request.headers));

  return withCorrelationContext(correlationContext, async () => {
    const org = orgDb.orgs.get(orgId);
    if (!org) {
      return orgNotFoundResponse(orgId);
    }

    const url = getRequestUrl(request, `/api/orgs/${orgId}/members`);
    const parsed = parseOrgPaginationParams(url.searchParams);
    if (!parsed.ok) {
      return errorResponse(parsed.code, parsed.message, 422);
    }

    const { page, hasNext, nextCursor } = paginateByKeyset(
      org.members,
      (member) => ({ timestamp: member.addedAt, id: member.walletAddress }),
      parsed.value,
    );

    logger.info("Org members listed", {
      org_id: orgId,
      member_count: page.length,
      total_members: org.members.length,
    });

    return NextResponse.json({
      data: page,
      meta: { total: org.members.length, hasNext, nextCursor },
      links: { self: `/api/orgs/${orgId}/members` },
    });
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const correlationContext = extractCorrelationContext(new Headers(request.headers));

  return withCorrelationContext(correlationContext, async () => {
    const org = orgDb.orgs.get(orgId);
    if (!org) {
      return orgNotFoundResponse(orgId);
    }

    // AuthZ: only owners may add members (MVP header-based check)
    const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() ?? "";
    if (!isOwner(org, actorAddress)) {
      logger.warn("Org member add rejected: forbidden", { org_id: orgId });
      return errorResponse(
        "FORBIDDEN",
        "Only org owners may add members.",
        403,
      );
    }

    const parsedBody = await readOrgJsonBody<{
      walletAddress?: string;
      role?: string;
    }>(request);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }
    const { walletAddress, role } = parsedBody.body;

    if (!walletAddress || typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
      return errorResponse("VALIDATION_ERROR", "Field 'walletAddress' is required.", 422);
    }
    if (!role || !VALID_ROLES.includes(role as OrgRole)) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Field 'role' must be one of: ${VALID_ROLES.join(", ")}.`,
        422,
      );
    }

    // Idempotent: if already a member, return existing record
    const existing = org.members.find((m) => m.walletAddress === walletAddress.trim());
    if (existing) {
      return NextResponse.json({ data: existing }, { status: 200 });
    }

    const newMember: OrgMember = {
      walletAddress: walletAddress.trim(),
      role: role as OrgRole,
      addedAt: new Date().toISOString(),
    };

    org.members.push(newMember);
    org.updatedAt = new Date().toISOString();
    orgDb.orgs.set(orgId, org);

    logger.info("Org member added", {
      org_id: orgId,
      role: newMember.role,
    });

    return NextResponse.json({ data: newMember }, { status: 201 });
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const correlationContext = extractCorrelationContext(new Headers(request.headers));

  return withCorrelationContext(correlationContext, async () => {
    const org = orgDb.orgs.get(orgId);
    if (!org) {
      return orgNotFoundResponse(orgId);
    }

    const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() ?? "";
    if (!isOwner(org, actorAddress)) {
      logger.warn("Org member role change rejected: forbidden", { org_id: orgId });
      return errorResponse("FORBIDDEN", "Only org owners may change member roles.", 403);
    }

    const parsedBody = await readOrgJsonBody<{
      walletAddress?: string;
      role?: string;
    }>(request);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }
    const { walletAddress, role } = parsedBody.body;

    if (!walletAddress || typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
      return errorResponse("VALIDATION_ERROR", "Field 'walletAddress' is required.", 422);
    }
    if (!role || !VALID_ROLES.includes(role as OrgRole)) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Field 'role' must be one of: ${VALID_ROLES.join(", ")}.`,
        422,
      );
    }

    const trimmedWallet = walletAddress.trim();
    const member = org.members.find((m) => m.walletAddress === trimmedWallet);
    if (!member) {
      return errorResponse(
        "MEMBER_NOT_FOUND",
        `Member '${trimmedWallet}' not found in org '${orgId}'.`,
        404,
      );
    }

    const nextRole = role as OrgRole;
    if (member.role === nextRole) {
      return NextResponse.json({ data: member }, { status: 200 });
    }

    if (member.role === "owner" && countOwners(org) <= 1) {
      return errorResponse(
        "LAST_OWNER",
        "Cannot demote the only remaining owner of an org.",
        409,
      );
    }

    const fromRole = member.role;
    member.role = nextRole;
    org.updatedAt = new Date().toISOString();
    orgDb.orgs.set(orgId, org);

    appendMemberAudit(
      request,
      "org.member.role_changed",
      orgId,
      trimmedWallet,
      fromRole,
      nextRole,
    );

    logger.info("Org member role changed", {
      from_role: fromRole,
      org_id: orgId,
      to_role: nextRole,
    });

    return NextResponse.json({ data: member }, { status: 200 });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const correlationContext = extractCorrelationContext(new Headers(request.headers));

  return withCorrelationContext(correlationContext, async () => {
    const org = orgDb.orgs.get(orgId);
    if (!org) {
      return orgNotFoundResponse(orgId);
    }

    const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() ?? "";
    if (!isOwner(org, actorAddress)) {
      logger.warn("Org member removal rejected: forbidden", { org_id: orgId });
      return errorResponse("FORBIDDEN", "Only org owners may remove members.", 403);
    }

    const { searchParams } = new URL(request.url);
    let walletAddress = searchParams.get("walletAddress")?.trim() ?? "";

    if (!walletAddress) {
      const parsedBody = await readOrgJsonBody<{ walletAddress?: string }>(request);
      if (!parsedBody.ok) {
        return parsedBody.response;
      }
      walletAddress =
        typeof parsedBody.body.walletAddress === "string"
          ? parsedBody.body.walletAddress.trim()
          : "";
    }

    if (!walletAddress) {
      return errorResponse("VALIDATION_ERROR", "Field 'walletAddress' is required.", 422);
    }

    const memberIndex = org.members.findIndex((m) => m.walletAddress === walletAddress);
    if (memberIndex === -1) {
      return errorResponse(
        "MEMBER_NOT_FOUND",
        `Member '${walletAddress}' not found in org '${orgId}'.`,
        404,
      );
    }

    const member = org.members[memberIndex];
    if (member.role === "owner" && countOwners(org) <= 1) {
      return errorResponse(
        "LAST_OWNER",
        "Cannot remove the only remaining owner of an org.",
        409,
      );
    }

    org.members.splice(memberIndex, 1);
    org.updatedAt = new Date().toISOString();
    orgDb.orgs.set(orgId, org);

    appendMemberAudit(
      request,
      "org.member.removed",
      orgId,
      walletAddress,
      member.role,
      null,
    );

    logger.info("Org member removed", { org_id: orgId, role: member.role });

    return NextResponse.json(
      { data: { removed: true, walletAddress } },
      { status: 200 },
    );
  });
}
