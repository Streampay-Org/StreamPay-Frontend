import type { Stream } from "@/app/types/openapi";
import { getAdminAddress } from "@/app/lib/admin-guard";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { orgDb } from "@/app/lib/org-db";
import { DEFAULT_STREAM_TENANT_ID, TENANT_COOKIE_NAME } from "@/app/lib/stream-tenant";

/**
 * Flexible actor representation accepted by {@link visibleTo}.
 *
 * Can be a wallet address string, an authenticated actor object from
 * `tryAuthenticateRequest`, or `null` / `undefined` for unauthenticated callers.
 */
export interface StreamActorObject {
  actorId?: string | null;
  id?: string | null;
  walletAddress?: string | null;
  address?: string | null;
  role?: string | null;
  isAdmin?: boolean;
  orgIds?: readonly string[];
}

export type StreamActor = string | StreamActorObject | null | undefined;

export const STREAM_PII_FIELDS = ["email", "label", "memo", "partnerId"] as const;

/**
 * Resolves the effective tenant identifier for a persisted stream.
 *
 * Supports both `tenantId` and `tenant` properties on the stream record,
 * falling back to {@link DEFAULT_STREAM_TENANT_ID} when unset or blank.
 */
export function resolveStreamTenant(stream: Stream): string {
  const candidate =
    stream.tenantId?.trim() ||
    stream.tenant?.trim();
  return candidate && candidate.length > 0 ? candidate : DEFAULT_STREAM_TENANT_ID;
}

/**
 * Extracts a tenant identifier from a Cookie header when present.
 */
function parseTenantCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rest] = segment.split("=");
    if (rawName?.trim() === TENANT_COOKIE_NAME) {
      const value = rest.join("=").trim();
      if (value.length > 0) {
        try {
          return decodeURIComponent(value);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the caller's tenant from request headers (`x-tenant-id`,
 * `x-streampay-tenant-id`) or tenant cookie, falling back to
 * {@link DEFAULT_STREAM_TENANT_ID}.
 */
export function resolveRequestTenant(request: Request): string {
  const headerTenant =
    request.headers?.get?.("x-tenant-id")?.trim() ||
    request.headers?.get?.("x-streampay-tenant-id")?.trim() ||
    parseTenantCookie(request.headers?.get?.("cookie") ?? null)?.trim();

  return headerTenant && headerTenant.length > 0
    ? headerTenant
    : DEFAULT_STREAM_TENANT_ID;
}

/**
 * Resolves the caller identity from a verified Bearer JWT, or from explicitly
 * enabled non-production actor headers. Header identities are never admins.
 *
 * Returns `null` when no verified actor is present and
 * `STREAMPAY_ALLOW_ACTOR_HEADER` is not exactly `"true"`. Invalid Bearer
 * tokens never fall back to header identities.
 */
export function resolveRequestActor(request: Request): StreamActorObject | null {
  const jwtActor = tryAuthenticateRequest(request);
  if (jwtActor) {
    const isAdmin =
      jwtActor.role === "admin" ||
      jwtActor.walletAddress === getAdminAddress();
    return {
      actorId: jwtActor.actorId,
      walletAddress: jwtActor.walletAddress,
      role: isAdmin ? "admin" : jwtActor.role,
      isAdmin,
    };
  }

  if (request.headers?.get?.("authorization")) {
    return null;
  }

  if (
    process.env.STREAMPAY_ALLOW_ACTOR_HEADER !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    return null;
  }

  const walletHeader =
    request.headers?.get?.("Actor-Wallet-Address")?.trim() ||
    request.headers?.get?.("x-wallet-address")?.trim() ||
    request.headers?.get?.("x-actor-id")?.trim() ||
    request.headers?.get?.("x-streampay-actor-id")?.trim() ||
    null;

  if (walletHeader && walletHeader.length > 0) {
    return {
      actorId: walletHeader,
      walletAddress: walletHeader,
      role: "user",
      isAdmin: false,
    };
  }

  return null;
}

interface NormalizedActor {
  walletAddress: string | null;
  isAdmin: boolean;
  orgIds: ReadonlySet<string>;
}

function normalizeActor(actor: StreamActor): NormalizedActor | null {
  if (!actor) {
    return null;
  }

  const adminAddress = getAdminAddress();

  if (typeof actor === "string") {
    const trimmed = actor.trim();
    if (!trimmed) {
      return null;
    }
    return {
      walletAddress: trimmed,
      isAdmin: trimmed === adminAddress,
      orgIds: new Set<string>(),
    };
  }

  const wallet =
    actor.walletAddress?.trim() ||
    actor.address?.trim() ||
    actor.actorId?.trim() ||
    actor.id?.trim() ||
    null;
  const role = actor.role?.trim()?.toLowerCase() ?? null;
  const isAdmin =
    actor.isAdmin === true ||
    (actor.isAdmin !== false &&
      (role === "admin" || (wallet !== null && wallet === adminAddress)));

  if (!wallet && !isAdmin && (!actor.orgIds || actor.orgIds.length === 0)) {
    return null;
  }

  return {
    walletAddress: wallet,
    isAdmin,
    orgIds: new Set(actor.orgIds ?? []),
  };
}

/**
 * Checks whether `walletAddress` (or `orgIds`) is a member of the organisation
 * that owns `stream`.
 */
function isOrgMemberForStream(
  stream: Stream,
  walletAddress: string | null,
  actorOrgIds: ReadonlySet<string>,
): boolean {
  const owningOrgId = stream.orgId?.trim() || orgDb.streamOwnership.get(stream.id);
  if (!owningOrgId) {
    return false;
  }

  if (actorOrgIds.has(owningOrgId)) {
    return true;
  }

  if (!walletAddress) {
    return false;
  }

  const org = orgDb.orgs.get(owningOrgId);
  if (!org) {
    return false;
  }

  return org.members.some((member) => member.walletAddress === walletAddress);
}

/**
 * Filter predicate `visibleTo(actor, tenant)(stream)`.
 *
 * A stream is visible when:
 * 1. It belongs to the same `tenant` as the caller, AND
 * 2. Either:
 *    - No verified `actor` is supplied (tenant-only fallback for unauthenticated
 *      v1 callers or v2 callers without a verified actor claim), OR
 *    - The actor is an admin, OR
 *    - The actor is the stream's `senderAddress` or `recipient`, OR
 *    - The actor is a member of the stream's owning organisation.
 */
export function visibleTo(
  actor: StreamActor,
  tenant?: string | null,
): (stream: Stream) => boolean {
  const targetTenant =
    tenant && tenant.trim().length > 0 ? tenant.trim() : DEFAULT_STREAM_TENANT_ID;
  const normalizedActor = normalizeActor(actor);

  return (stream: Stream): boolean => {
    if (resolveStreamTenant(stream) !== targetTenant) {
      return false;
    }

    if (!normalizedActor) {
      return true;
    }

    if (normalizedActor.isAdmin) {
      return true;
    }

    const { walletAddress, orgIds } = normalizedActor;
    if (
      walletAddress &&
      (stream.senderAddress === walletAddress || stream.recipient === walletAddress)
    ) {
      return true;
    }

    if (isOrgMemberForStream(stream, walletAddress, orgIds)) {
      return true;
    }

    return false;
  };
}

/**
 * Redacts PII fields (`email`, `label`, `memo`, `partnerId`) by omitting them
 * from the returned stream object for unauthenticated v1 callers.
 */
export function redactStreamPii(stream: Stream): Stream {
  const clone: Stream = { ...stream };
  delete clone.email;
  delete clone.label;
  delete clone.memo;
  delete clone.partnerId;
  return clone;
}
