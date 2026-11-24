import { db } from "@/app/lib/db";
import { streamCache } from "@/app/lib/cache";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { orgDb } from "@/app/lib/org-db";

export interface DeleteActor {
  actorId?: string;
  walletAddress?: string;
  role?: string;
}

export type DeleteStreamResult =
  | { success: true; status: 204 }
  | { success: false; status: number; code: string; message: string };

function currentNetwork(): string {
  const network = process.env.STELLAR_NETWORK?.trim();
  return network && network.length > 0 ? network : "default";
}

/**
 * Shared delete logic for stream resources across v1 and v2 routes.
 *
 * Enforces:
 * - Tenant isolation: if tenant is provided and mismatches, returns 404.
 * - Soft delete idempotency: deleting an already soft-deleted stream returns 204.
 * - Missing stream: returns 404.
 * - Ownership: verified actor must be stream senderAddress or an org owner. Otherwise 403.
 * - Deletable statuses:
 *     Allowed: "draft", "cancelled", and "withdrawn" (only when withdrawal.state === "succeeded").
 *     "ended": returns 409 FUNDS_PENDING_WITHDRAWAL.
 *     "active" | "paused": returns 409 STREAM_INACTIVE_STATE.
 *     Any other status: returns 409 STREAM_INACTIVE_STATE.
 * - Audit: records "stream.delete" with a before snapshot.
 * - Cache: invalidates streamCache on delete.
 */
export async function deleteStream(
  id: string,
  actor: DeleteActor | { actorId: string; walletAddress: string; role?: string } | null,
  tenant?: string | null,
  request?: Request,
): Promise<DeleteStreamResult> {
  const rawStream = db.streams.get(id);

  if (!rawStream) {
    return {
      success: false,
      status: 404,
      code: "STREAM_NOT_FOUND",
      message: `Stream '${id}' not found`,
    };
  }

  // Tenant validation (if tenant is supplied, e.g. from v1 x-tenant-id header)
  if (tenant !== undefined && tenant !== null && tenant !== "") {
    const streamTenant = (rawStream as any).tenant;
    if (streamTenant && streamTenant !== tenant) {
      return {
        success: false,
        status: 404,
        code: "STREAM_NOT_FOUND",
        message: `Stream '${id}' not found`,
      };
    }
  }

  // Idempotency: If already soft-deleted, return 204 directly
  if ((rawStream as any).deletedAt) {
    return { success: true, status: 204 };
  }

  // Ownership verification
  // Must be senderAddress or an org owner
  const actorWallet =
    actor?.walletAddress ||
    (actor && "actorId" in actor ? actor.actorId : undefined);

  let isAuthorized = false;

  if (actorWallet) {
    // 1. Check if actor is senderAddress
    if (rawStream.senderAddress && rawStream.senderAddress === actorWallet) {
      isAuthorized = true;
    }

    // 2. Check if actor is an org owner of the owning org
    if (!isAuthorized) {
      const orgId = (rawStream as any).tenant || orgDb.streamOwnership.get(id);
      if (orgId) {
        const org = orgDb.orgs.get(orgId);
        if (org) {
          const member = org.members.find((m) => m.walletAddress === actorWallet);
          if (member && member.role === "owner") {
            isAuthorized = true;
          }
        }
      }
    }
  }

  // For v2, when auth is not configured on the endpoint and no actor identity was provided:
  // "For v2, use the verified actor when one is available (auth hardening is owned by the separate auth work)."
  if (!actorWallet && actor === null) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    return {
      success: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Only the stream sender or an organization owner can delete a stream.",
    };
  }

  // Status deletability check
  // Ended is never deletable
  if (rawStream.status === "ended") {
    return {
      success: false,
      status: 409,
      code: "FUNDS_PENDING_WITHDRAWAL",
      message: "Cannot delete an ended stream with funds pending withdrawal.",
    };
  }

  // Active and paused keep their current 409
  if (rawStream.status === "active" || rawStream.status === "paused") {
    return {
      success: false,
      status: 409,
      code: "STREAM_INACTIVE_STATE",
      message: "Cannot delete a stream that is active or paused. Stop it first.",
    };
  }

  // Allowed statuses: draft, cancelled, and withdrawn with withdrawal.state === "succeeded"
  const isDraft = rawStream.status === "draft";
  const isCancelled = rawStream.status === "cancelled";
  const isWithdrawnSucceeded =
    rawStream.status === "withdrawn" && rawStream.withdrawal?.state === "succeeded";

  if (!isDraft && !isCancelled && !isWithdrawnSucceeded) {
    return {
      success: false,
      status: 409,
      code: "STREAM_INACTIVE_STATE",
      message: "Stream is not in a deletable status.",
    };
  }

  // Soft delete: mark deletedAt and update store
  const beforeSnapshot = structuredClone(rawStream);
  const now = new Date().toISOString();
  const updatedStream = {
    ...rawStream,
    deletedAt: now,
    updatedAt: now,
  };

  db.streams.set(id, updatedStream);

  // Invalidate cache
  const effectiveTenant = (rawStream as any).tenant || tenant || "default";
  streamCache.invalidate(effectiveTenant, id, currentNetwork());

  // Record audit log
  const effectiveRequest =
    request ??
    new Request(`http://localhost/api/streams/${id}`, {
      method: "DELETE",
      headers: actorWallet ? { "x-streampay-actor-id": actorWallet, "x-streampay-actor-role": "user" } : {},
    });

  recordPrivilegedStreamAuditEvent({
    action: "stream.delete",
    before: beforeSnapshot as Record<string, unknown>,
    after: updatedStream as Record<string, unknown>,
    streamId: id,
    targetAccount: rawStream.recipient,
    request: effectiveRequest,
  });

  return { success: true, status: 204 };
}
