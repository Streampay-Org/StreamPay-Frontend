import { tryAuthenticateRequest } from "@/app/lib/auth";

/**
 * Tenant used when a request carries no tenant context.
 *
 * Kept stable across releases so streams created before tenant stamping
 * existed and clients that omit `x-tenant-id` keep resolving to the same
 * rows. Never use `undefined` as a tenant: every persisted stream must have
 * a non-empty `tenantId`.
 */
export const DEFAULT_TENANT = "public";

/** Trim a tenant identifier, treating whitespace-only values as absent. */
export function normaliseTenant(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the tenant for a request.
 *
 * Resolution order:
 *   1. `tenantId` claim on a verified JWT (set by `tryAuthenticateRequest`).
 *   2. `x-tenant-id` request header.
 *
 * Returns `null` when neither source carries a non-empty value. Callers that
 * need a concrete tenant should use {@link resolveRequestTenantOrDefault}.
 */
export function resolveRequestTenant(request: Request): string | null {
  const actor = tryAuthenticateRequest(request);
  const claimedTenant = normaliseTenant(actor?.tenantId);
  if (claimedTenant) {
    return claimedTenant;
  }

  return normaliseTenant(request.headers?.get?.("x-tenant-id") ?? null);
}

/**
 * Resolve the tenant, falling back to {@link DEFAULT_TENANT} for requests
 * without tenant context. Used by read/mutate handlers so v1 clients that
 * never sent `x-tenant-id` remain backward compatible.
 */
export function resolveRequestTenantOrDefault(request: Request): string {
  return resolveRequestTenant(request) ?? DEFAULT_TENANT;
}
