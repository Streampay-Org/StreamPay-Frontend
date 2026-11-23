/**
 * GET /api/orgs/:orgId — Get org details (members, policy)
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { withRouteTimeout } from "@/src/middleware/timeout";

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status },
  );
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

  // Determine which streams this org owns
  const ownedStreams: string[] = [];
  for (const [streamId, owner] of orgDb.streamOwnership.entries()) {
    if (owner === orgId) ownedStreams.push(streamId);
  }

  return NextResponse.json({
    data: {
      ...org,
      ownedStreams,
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
