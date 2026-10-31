/**
 * Tenant constants shared by the stream view, visibility rules and the
 * in-memory repository.
 *
 * Kept in a dependency-free leaf module so the repository can import them
 * without creating a `stream-view -> db -> repositories -> stream-view`
 * initialisation cycle.
 */

/**
 * Default tenant for streams and viewers that carry no explicit tenant.
 *
 * Matches the value the dashboard's own client-side fetches use
 * (`app/activity/page.tsx`). Seeded demo streams and streams created through
 * `POST /api/streams` are stored without a `tenant` field and therefore belong
 * to this tenant.
 */
export const DEFAULT_STREAM_TENANT_ID = "default-tenant";

/** Cookie the browser may carry to scope page renders to a tenant. */
export const TENANT_COOKIE_NAME = "sp_tenant_id";
