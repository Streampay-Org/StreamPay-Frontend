/**
 * GET    /api/orgs/:orgId — Get org details (members, policy)
 * PATCH  /api/orgs/:orgId — Rename an org
 * DELETE /api/orgs/:orgId — Delete an org
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { OrgRecord } from "@/app/lib/org-types";
import { readOrgJsonBody } from "@/app/lib/org-request-body";
import { auditLogStore, buildRequestId, resolveAuditActor } from "@/app/lib/audit-log";
import { withRouteTimeout } from "@/src/middleware/timeout";

const MAX_ORG_NAME_LENGTH = 100;

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status },
  );
}

function ownedStreamIds(orgId: string): string[] {
  const owned: string[] = [];
  for (const [streamId, owner] of orgDb.streamOwnership.entries()) {
    if (owner === orgId) owned.push(streamId);
  }
  return owned;
}

function isOwner(org: OrgRecord, actorAddress: string): boolean {
  return org.members.some(
    (member) => member.walletAddress === actorAddress && member.role === "owner",
  );
}

function hasActiveApprovals(orgId: string): boolean {
  const now = Date.now();
  for (const approval of orgDb.approvals.values()) {
    if (approval.orgId !== orgId) continue;
    if (approval.status !== "pending") continue;
    if (Date.parse(approval.expiresAt) > now) return true;
  }
  return false;
}

function appendOrgAudit(
  request: Request,
  action: string,
  orgId: string,
  metadata: Record<string, string | number | boolean | null>,
) {
  auditLogStore.append({
    action,
    actor: resolveAuditActor(request),
    metadata: { orgId, ...metadata },
    requestId: buildRequestId(request),
    target: { id: `org:${orgId}`, type: "request" },
  });
}

async function handleOrgGet(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const org = orgDb.orgs.get(orgId);

  if (!org) {
    return errorResponse("ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
  }

  return NextResponse.json({
    data: {
      ...org,
      ownedStreams: ownedStreamIds(orgId),
      tokenAllowlist: org.tokenAllowlist ?? [],
    },
    links: { self: `/api/orgs/${orgId}` },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ orgId: string }> },
) {
  return withRouteTimeout(request, () => handleOrgGet(request, ctx));
}

async function handleOrgPatch(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const org = orgDb.orgs.get(orgId);
  if (!org) {
    return errorResponse("ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
  }

  const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() ?? "";
  if (!isOwner(org, actorAddress)) {
    return errorResponse("FORBIDDEN", "Only org owners may rename the org.", 403);
  }

  const parsedBody = await readOrgJsonBody<{ name?: unknown }>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const rawName = parsedBody.body.name;
  if (typeof rawName !== "string") {
    return errorResponse("VALIDATION_ERROR", "Field 'name' is required.", 422);
  }

  const name = rawName.trim();
  if (name.length === 0 || name.length > MAX_ORG_NAME_LENGTH) {
    return errorResponse(
      "VALIDATION_ERROR",
      `Field 'name' must be between 1 and ${MAX_ORG_NAME_LENGTH} characters.`,
      422,
    );
  }

  const fromName = org.name;
  if (fromName === name) {
    return NextResponse.json({
      data: { ...org, ownedStreams: ownedStreamIds(orgId), tokenAllowlist: org.tokenAllowlist ?? [] },
      links: { self: `/api/orgs/${orgId}` },
    });
  }

  org.name = name;
  org.updatedAt = new Date().toISOString();
  orgDb.orgs.set(orgId, org);

  appendOrgAudit(request, "org.rename", orgId, { fromName, toName: name });

  return NextResponse.json({
    data: { ...org, ownedStreams: ownedStreamIds(orgId), tokenAllowlist: org.tokenAllowlist ?? [] },
    links: { self: `/api/orgs/${orgId}` },
  });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ orgId: string }> },
) {
  return withRouteTimeout(request, () => handleOrgPatch(request, ctx));
}

async function handleOrgDelete(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const org = orgDb.orgs.get(orgId);
  if (!org) {
    return errorResponse("ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
  }

  const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() ?? "";
  if (!isOwner(org, actorAddress)) {
    return errorResponse("FORBIDDEN", "Only org owners may delete the org.", 403);
  }

  const ownedStreams = ownedStreamIds(orgId);
  if (ownedStreams.length > 0) {
    return errorResponse(
      "ORG_HAS_STREAMS",
      `Org '${orgId}' still owns ${ownedStreams.length} stream(s) and cannot be deleted.`,
      409,
    );
  }

  if (hasActiveApprovals(orgId)) {
    return errorResponse(
      "ORG_HAS_PENDING_APPROVALS",
      `Org '${orgId}' has pending approvals and cannot be deleted.`,
      409,
    );
  }

  const name = org.name;
  orgDb.orgs.delete(orgId);

  appendOrgAudit(request, "org.delete", orgId, { name });

  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ orgId: string }> },
) {
  return withRouteTimeout(request, () => handleOrgDelete(request, ctx));
}
