import type { Stream } from "@/app/types/openapi";
import { getStore } from "./db";
import { DEFAULT_STREAM_TENANT_ID, TENANT_COOKIE_NAME } from "./stream-tenant";

export { DEFAULT_STREAM_TENANT_ID, TENANT_COOKIE_NAME };

/** Header the dashboard's API layer already allow-lists for carrying the caller's actor identity. */
export const ACTOR_HEADER_NAME = "x-streampay-actor-id";

export interface StreamViewerContext {
  /**
   * Tenant the viewer is acting on behalf of, e.g. from the `x-tenant-id`
   * header or {@link TENANT_COOKIE_NAME} cookie. Empty/whitespace values fall
   * back to {@link DEFAULT_STREAM_TENANT_ID}.
   */
  tenant?: string | null;
  /**
   * Resolved viewer identity (wallet address or internal actor id).
   *
   * Carried so callers share a single context shape with the API routes; the
   * GET visibility check this loader mirrors (`GET /api/streams/[id]`) is
   * tenant-only, so the actor is recorded but does not further restrict
   * access today.
   */
  actor?: string | null;
}

/**
 * Resolve a single stream for a viewer, applying the same tenant and
 * visibility rule as `GET /api/streams/[id]`.
 *
 * The API route resolves through `db.streams.findOne(tenant, id)`, which only
 * returns a row whose persisted `tenant` equals the requested tenant. This
 * loader mirrors that check exactly for streams that carry a tenant, and
 * treats tenant-less rows (the seeded demo streams and streams created via
 * `POST /api/streams`) as belonging to {@link DEFAULT_STREAM_TENANT_ID}.
 *
 * Returns `null` — never throws — when the stream does not exist or is not
 * visible, so callers can render `notFound()` (404) without differing
 * behaviour between "missing" and "not yours".
 */
export function loadStreamForViewer(
  id: string,
  { tenant }: StreamViewerContext = {},
): Stream | null {
  const stream = getStore().streamRepository.streams.get(id);
  if (!stream) {
    return null;
  }

  const streamTenant =
    (stream as { tenant?: string }).tenant?.trim() || DEFAULT_STREAM_TENANT_ID;
  const viewerTenant = tenant?.trim() || DEFAULT_STREAM_TENANT_ID;

  if (streamTenant !== viewerTenant) {
    return null;
  }

  return stream;
}
