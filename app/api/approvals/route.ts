/**
 * GET /api/approvals — Read-only cross-stream aggregation of org-owned stream approvals.
 *
 * Collects approvals across all org-owned streams in `orgDb` so the /approvals
 * inbox does not need to fan out N+1 requests per stream.
 *
 * Optional filtering:
 * - `Actor-Wallet-Address` header: when provided, restricts results to approvals
 *   belonging to orgs of which the wallet is a member.
 * - `status` query param (`pending` | `approved` | `rejected` | `expired`):
 *   filters the returned `data` array while `meta.counts` reflects the full
 *   unfiltered totals for the visible orgs.
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import type { ApprovalStatus, PendingApproval } from "@/app/lib/org-types";

const VALID_STATUSES = new Set<ApprovalStatus>([
  "pending",
  "approved",
  "rejected",
  "expired",
]);

function getRequestUrl(request: Request): URL {
  try {
    return request.url ? new URL(request.url) : new URL("http://localhost/api/approvals");
  } catch {
    return new URL("http://localhost/api/approvals");
  }
}

export async function GET(request: Request) {
  const actorAddress = request.headers?.get?.("Actor-Wallet-Address")?.trim() || null;
  const url = getRequestUrl(request);
  const statusParam = url.searchParams.get("status")?.trim().toLowerCase() || null;

  if (statusParam && !VALID_STATUSES.has(statusParam as ApprovalStatus)) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid status '${statusParam}'. Expected one of: pending, approved, rejected, expired.`,
          request_id: "mock-request-id",
        },
      },
      { status: 400 },
    );
  }

  // If an actor wallet is provided, restrict to orgs where the wallet is a member.
  let allowedOrgIds: Set<string> | null = null;
  if (actorAddress) {
    allowedOrgIds = new Set<string>();
    for (const org of orgDb.orgs.values()) {
      if (org.members.some((m) => m.walletAddress === actorAddress)) {
        allowedOrgIds.add(org.id);
      }
    }
  }

  const now = new Date();
  const visible: PendingApproval[] = [];

  for (const approval of orgDb.approvals.values()) {
    // Only include approvals for org-owned streams
    if (!orgDb.streamOwnership.has(approval.streamId)) continue;

    if (allowedOrgIds && !allowedOrgIds.has(approval.orgId)) continue;

    let current = approval;
    if (current.status === "pending" && new Date(current.expiresAt) <= now) {
      current = { ...current, status: "expired" };
      orgDb.approvals.set(current.id, current);
    }

    visible.push(current);
  }

  // Sort newest first
  visible.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const counts: Record<ApprovalStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
  };
  for (const item of visible) {
    counts[item.status] += 1;
  }

  const filtered = statusParam
    ? visible.filter((item) => item.status === statusParam)
    : visible;

  return NextResponse.json({
    data: filtered,
    meta: {
      total: filtered.length,
      counts,
    },
    links: {
      self: "/api/approvals",
    },
  });
}
