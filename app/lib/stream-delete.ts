import { db } from "@/app/lib/db";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { streamCache } from "@/app/lib/cache";

export interface DeleteActor {
  id?: string;
  address?: string | null;
  role?: string;
  orgId?: string;
  isOrgOwner?: boolean;
  orgOwner?: boolean;
}

export type DeleteResult =
  | { kind: "ok"; status: 204 }
  | { kind: "error"; status: 403 | 404 | 409 | 400; code: string; message: string };

function normalizeActorAddress(actor: DeleteActor | null | undefined): string | null {
  if (!actor) return null;
  const address = typeof actor.address === "string" ? actor.address : null;
  return address && address.trim() ? address.trim() : null;
}

function currentNetwork(): string {
  const network = process.env.STELLAR_NETWORK?.trim();
  return network && network.length > 0 ? network : "default";
}

function findStream(tenant: string, id: string): any | null {
  // Prefer tenant-scoped lookup when available.
  if (db && db.streams && typeof db.streams.findOne === "function") {
    const scoped = db.streams.findOne(tenant, id);
    if (scoped) return scoped;
  }
  if (db && db.streams && typeof db.streams.get === "function") {
    const row = db.streams.get(id);
    if (row && (!row.tenantId || row.tenantId === tenant)) return row;
  }
  return null;
}

function isDeletable(stream: any): { allowed: boolean; code?: string; message?: string } {
  const status = stream?.status;
  if (status === "active" || status === "paused") {
    return {
      allowed: false,
      code: "STREAM_INACTIVE_STATE",
      message: "Cannot delete a stream that is active or paused. Stop it first.",
    };
  }
  if (status === "ended") {
    return {
      allowed: false,
      code: "FUNDS_PENDING_WITHDRAWAL",
      message: "Cannot delete an ended stream while funds are pending withdrawal.",
    };
  }
  if (status === "draft" || status === "cancelled") {
    return { allowed: true };
  }
  if (status === "withdrawn") {
    const withdrawalState = stream?.withdrawal?.state;
    if (withdrawalState === "succeeded") {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "FUNDS_PENDING_WITHDRAWAL",
      message: "Cannot delete a withdrawn stream until the withdrawal is confirmed.",
    };
  }
  // Unknown statuses are not deletable.
  return {
    allowed: false,
    code: "STREAM_INACTIVE_STATE",
    message: `Cannot delete a stream in status '${String(status)}'.`,
  };
}

function isAuthorizedActor(stream: any, actor: DeleteActor | null | undefined): boolean {
  if (!actor) return false;
  if (actor.isOrgOwner === true || actor.orgOwner === true) return true;
  const address = normalizeActorAddress(actor);
  if (!address) return false;
  const sender = typeof stream?.senderAddress === "string" ? stream.senderAddress : null;
  if (sender && sender === address) return true;
  // Org owner membership can also be signaled via actor.orgId matching the stream's org.
  if (actor.orgId && stream?.orgId && actor.orgId === stream.orgId) return true;
  return false;
}

function recordDeleteAudit(stream: any, actor: DeleteActor | null | undefined, tenant: string): void {
  try {
    const record = recordPrivilegedStreamAuditEvent as any;
    if (typeof record !== "function") return;
    const address = normalizeActorAddress(actor);
    record({
      action: "stream.delete",
      actor: {
        id: actor?.id ?? address ?? "system",
        role: (actor?.role as any) ?? "user",
        account: address ?? undefined,
      },
      target: {
        id: stream.id,
        type: "stream",
        account: stream.recipientAddress,
      },
      before: stream,
      metadata: { orgId: actor?.orgId ?? tenant },
    });
  } catch {
    // Audit failures must not block deletion.
  }
}

export async function deleteStream(
  id: string,
  actor: DeleteActor | null | undefined,
  tenant: string | null | undefined,
): Promise<DeleteResult> {
  if (!tenant || tenant.trim() === "") {
    return { kind: "error", status: 400, code: "MISSING_TENANT", message: "Tenant ID header is required" };
  }

  const stream = findStream(tenant, id);
  if (!stream) {
    return { kind: "error", status: 404, code: "STREAM_NOT_FOUND", message: `Stream '${id}' not found` };
  }

  // Tenant mismatch -> 404 (hide existence).
  if (stream.tenantId && stream.tenantId !== tenant) {
    return { kind: "error", status: 404, code: "STREAM_NOT_FOUND", message: `Stream '${id}' not found` };
  }

  // Idempotent: already soft-deleted -> 204.
  if (stream.deletedAt) {
    return { kind: "ok", status: 204 };
  }

  if (!isAuthorizedActor(stream, actor)) {
    return {
      kind: "error",
      status: 403,
      code: "STREAM_FORBIDDEN",
      message: "Only the stream sender or an org owner can delete this stream.",
    };
  }

  const deletability = isDeletable(stream);
  if (!deletability.allowed) {
    return {
      kind: "error",
      status: 409,
      code: deletability.code ?? "STREAM_INACTIVE_STATE",
      message: deletability.message ?? "Cannot delete this stream.",
    };
  }

  const deletedAt = new Date().toISOString();
  const updated = { ...stream, deletedAt, updatedAt: deletedAt };

  // Soft delete: persist the row with deletedAt set.
  if (db && db.streams && typeof db.streams.set === "function") {
    db.streams.set(id, updated);
  }

  // Invalidate cache so GET after delete returns 404 and stale If-None-Match cannot 304.
  try {
    streamCache?.invalidate?.(tenant, id, currentNetwork());
  } catch {
    // cache is optional in this code path
  }

  recordDeleteAudit(stream, actor, tenant);

  return { kind: "ok", status: 204 };
}
