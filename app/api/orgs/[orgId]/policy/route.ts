/**
 * Per-org stream policy endpoints
 *
 * GET /api/orgs/:orgId/policy
 *   Returns the org's current StreamPolicy with a strong ETag.
 *
 * PUT /api/orgs/:orgId/policy
 *   Replaces the org's StreamPolicy.
 *   Only org owners may update the policy.
 *   Supports optimistic concurrency via the If-Match header (409 STATE_CONFLICT on mismatch).
 *   Records an audit entry with before/after policy, actor, and request ID.
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import {
  ActorMismatchError,
  resolveActorAddress,
  validateStreamPolicy,
} from "@/app/lib/org-policy";
import type { StreamPolicy } from "@/app/lib/org-types";
import { computeETag, ifNoneMatchMatches } from "@/app/lib/etag";
import { auditLogStore } from "@/app/lib/audit-log";
import { resolveRequestId } from "@/lib/requestId";

function errorResponse(
  requestId: string,
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: requestId,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

function clonePolicy(policy: StreamPolicy): StreamPolicy {
  return {
    policyVersion: policy.policyVersion,
    canStart: [...policy.canStart],
    canPause: [...policy.canPause],
    canResume: [...policy.canResume],
    canSettle: [...policy.canSettle],
    canStop: [...policy.canStop],
    canWithdraw: [...policy.canWithdraw],
    requireApprovals: policy.requireApprovals,
  };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const requestId = resolveRequestId(request.headers);
  const { orgId } = await params;
  const org = orgDb.orgs.get(orgId);

  if (!org) {
    return errorResponse(requestId, "ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
  }

  const etag = computeETag(orgId, org.policy);

  return NextResponse.json(
    {
      data: {
        orgId,
        policy: clonePolicy(org.policy),
        updatedAt: org.updatedAt,
      },
      links: { self: `/api/orgs/${orgId}/policy` },
    },
    {
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    },
  );
}

// ── PUT ───────────────────────────────────────────────────────────────────────

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const requestId = resolveRequestId(request.headers);
  const { orgId } = await params;
  const org = orgDb.orgs.get(orgId);

  if (!org) {
    return errorResponse(requestId, "ORG_NOT_FOUND", `Org '${orgId}' not found.`, 404);
  }

  let actorAddress: string | null;
  try {
    actorAddress = resolveActorAddress(request);
  } catch (err) {
    if (err instanceof ActorMismatchError) {
      return errorResponse(requestId, "ACTOR_MISMATCH", err.message, 403);
    }
    throw err;
  }

  if (!actorAddress) {
    return errorResponse(
      requestId,
      "ACTOR_REQUIRED",
      "A verified actor identity is required to update the stream policy.",
      403,
    );
  }

  const member = org.members.find((m) => m.walletAddress === actorAddress);
  if (!member || member.role !== "owner") {
    return errorResponse(
      requestId,
      "FORBIDDEN",
      "Only org owners may update the stream policy.",
      403,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      requestId,
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
      400,
    );
  }

  const candidate =
    body && typeof body === "object" && !Array.isArray(body) && "policy" in body
      ? (body as { policy: unknown }).policy
      : body;

  const validation = validateStreamPolicy(candidate);
  if (!validation.ok) {
    return errorResponse(
      requestId,
      "VALIDATION_ERROR",
      "Invalid stream policy.",
      400,
      { fieldErrors: validation.errors },
    );
  }

  const currentEtag = computeETag(orgId, org.policy);
  const ifMatch = request.headers.get("if-match");

  if (ifMatch && !ifNoneMatchMatches(ifMatch, currentEtag)) {
    return errorResponse(
      requestId,
      "STATE_CONFLICT",
      "Stream policy has been modified concurrently. Please reload and retry.",
      409,
    );
  }

  const beforePolicy = clonePolicy(org.policy);
  const nextPolicy = validation.policy;

  org.policy = nextPolicy;
  org.updatedAt = new Date().toISOString();
  orgDb.orgs.set(orgId, org);

  auditLogStore.append({
    action: "org.policy.update",
    actor: { id: actorAddress, role: "admin" },
    target: { type: "account", id: orgId },
    before: beforePolicy as unknown as Record<string, unknown>,
    after: nextPolicy as unknown as Record<string, unknown>,
    requestId,
    metadata: {
      orgId,
      beforePolicy: JSON.stringify(beforePolicy),
      afterPolicy: JSON.stringify(nextPolicy),
    },
  });

  const newEtag = computeETag(orgId, org.policy);

  return NextResponse.json(
    {
      data: {
        orgId,
        policy: clonePolicy(org.policy),
        updatedAt: org.updatedAt,
      },
      links: { self: `/api/orgs/${orgId}/policy` },
    },
    {
      headers: {
        ETag: newEtag,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    },
  );
}
