/**
 * POST /api/orgs   — Create a new org
 * GET  /api/orgs   — List all orgs (omits member wallet addresses for privacy)
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { OrgRecord, OrgMember, DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { orgCreateStore, withIdempotency } from "@/app/lib/idempotency";
import {
  paginateByKeyset,
  parseOrgPaginationParams,
} from "@/app/lib/org-pagination";

const orgCreateLocks = new Map<string, Promise<void>>();

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status },
  );
}

function getRequestUrl(request: Request, fallbackPath: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
  } catch {
    return new URL(`http://localhost${fallbackPath}`);
  }
}

async function handleOrgsGet(request: Request) {
  const url = getRequestUrl(request, "/api/orgs");
  const parsed = parseOrgPaginationParams(url.searchParams);
  if (!parsed.ok) {
    return errorResponse(parsed.code, parsed.message, 422);
  }

  const allOrgs = Array.from(orgDb.orgs.values());
  const { page, hasNext, nextCursor } = paginateByKeyset(
    allOrgs,
    (org) => ({ timestamp: org.createdAt, id: org.id }),
    parsed.value,
  );

  const orgs = page.map((org) => ({
    id: org.id,
    name: org.name,
    memberCount: org.members.length,
    policy: org.policy,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  }));

  return NextResponse.json({
    data: orgs,
    meta: { total: allOrgs.length, hasNext, nextCursor },
  });
}

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleOrgsGet(request));
}

async function handleOrgsPost(request: Request) {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  const { name, ownerWalletAddress } = body as {
    name?: string;
    ownerWalletAddress?: string;
  };

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("VALIDATION_ERROR", "Field 'name' is required.", 422);
  }
  if (
    !ownerWalletAddress ||
    typeof ownerWalletAddress !== "string" ||
    ownerWalletAddress.trim().length === 0
  ) {
    return errorResponse("VALIDATION_ERROR", "Field 'ownerWalletAddress' is required.", 422);
  }

  const createOrg = async () => {
  const id = `org-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const owner: OrgMember = {
    walletAddress: ownerWalletAddress.trim(),
    role: "owner",
    addedAt: now,
  };

  const newOrg: OrgRecord = {
    id,
    name: name.trim(),
    members: [owner],
    policy: { ...DEFAULT_STREAM_POLICY },
    createdAt: now,
    updatedAt: now,
  };

  orgDb.orgs.set(id, newOrg);

  return NextResponse.json(
    { data: newOrg, links: { self: `/api/orgs/${id}` } },
    { status: 201 },
  );
  };

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey === null) return createOrg();

  // Prefer the verified identity for isolation; unauthenticated callers are
  // scoped to the requested owner wallet so separate owners cannot replay.
  const actor = tryAuthenticateRequest(request);
  const actorId = actor?.actorId ?? ownerWalletAddress.trim();
  // Serialize same actor/key attempts in-process so lookup + create + persist
  // behaves atomically for concurrent client retries.
  const lockKey = `${actorId}\u0000${idempotencyKey}`;
  const previous = orgCreateLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  orgCreateLocks.set(lockKey, current);
  await previous;
  try {
    return await withIdempotency(request, "orgs.create", orgCreateStore, createOrg, {
      resourceId: "orgs",
      actorId,
    });
  } finally {
    release();
    if (orgCreateLocks.get(lockKey) === current) orgCreateLocks.delete(lockKey);
  }
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleOrgsPost(request));
}
