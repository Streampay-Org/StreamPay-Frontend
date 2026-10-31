/**
 * CORS allowlist helpers for browser-origin validation.
 *
 * The public API surface is protected by an explicit origin allowlist.
 * Wildcard `*` is permitted only in non-production environments.
 *
 * The decision helper (`buildCorsDecision`) is shared by the middleware and
 * the unit tests so both agree on one decision table:
 *
 * | kind          | meaning                                              |
 * |---------------|------------------------------------------------------|
 * | `none`        | no `Origin` header (same-origin navigation, curl)      |
 * | `same-origin` | the origin matches the request origin (no allowlist)    |
 * | `allowed`     | the origin is on the allowlist                         |
 * | `null-origin` | `Origin: null` (sandboxed iframe / `file://`)           |
 * | `denied`      | cross-origin and not on the allowlist                  |
 */

export const WILDCARD_ORIGIN = '*';

export const DEFAULT_CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const DEFAULT_CORS_HEADERS = 'authorization, content-type, x-requested-with, x-api-key, x-streampay-actor-id, x-streampay-actor-role';
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600;

/**
 * Response headers browser clients are allowed to read on a cross-origin
 * response. `x-request-id` is required for incident correlation,
 * `retry-after` for rate-limit back-off and `etag` for conditional reads.
 */
export const DEFAULT_CORS_EXPOSE_HEADERS = 'x-request-id, retry-after, etag';

/**
 * The literal `Origin: null` header value. Browsers send it for sandboxed
 * iframes, `file://` documents and other opaque origins. It is never a real
 * origin, so it can never be allowlisted and is always rejected.
 */
export const NULL_ORIGIN = 'null';

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeOrigin(origin: string): string {
  if (origin === WILDCARD_ORIGIN) {
    return WILDCARD_ORIGIN;
  }

  const url = new URL(origin);

  if (url.origin !== origin) {
    return url.origin;
  }

  return url.origin;
}

export function buildAllowedOriginSet(raw: string | undefined): Set<string> {
  return new Set(parseAllowedOrigins(raw).map(normalizeOrigin));
}

/**
 * True when the `Origin` header carries the opaque `null` origin.
 */
export function isNullOrigin(origin: string | null | undefined): boolean {
  if (typeof origin !== 'string') {
    return false;
  }

  return origin.trim().toLowerCase() === NULL_ORIGIN;
}

/**
 * True when the request `Origin` is the same origin as the request itself.
 *
 * Comparison happens on normalised origins (lower-case host, default ports
 * stripped), so `https://APP.example:443` and `https://app.example` match.
 */
export function isSameOrigin(
  origin: string | null | undefined,
  requestOrigin: string | null | undefined,
): boolean {
  if (!origin || !requestOrigin) {
    return false;
  }

  if (isNullOrigin(origin) || isNullOrigin(requestOrigin)) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(requestOrigin).origin;
  } catch {
    return false;
  }
}

export function isOriginAllowed(origin: string | null | undefined, allowedOrigins: string[] | Set<string>): boolean {
  if (!origin) {
    return false;
  }

  const normalizedOrigin = (() => {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  })();

  if (!normalizedOrigin) {
    return false;
  }

  if (allowedOrigins instanceof Set) {
    return allowedOrigins.has(WILDCARD_ORIGIN) || allowedOrigins.has(normalizedOrigin);
  }

  return allowedOrigins.includes(WILDCARD_ORIGIN) || allowedOrigins.includes(normalizedOrigin);
}

export type CorsDecisionKind = 'none' | 'same-origin' | 'allowed' | 'null-origin' | 'denied';

export interface CorsDecision {
  kind: CorsDecisionKind;
  origin: string | null;
}

/**
 * Minimal request shape used by the decision helper, so the helper stays
 * testable without pulling in the Next.js request runtime.
 */
export interface CorsRequestLike {
  headers: { get(name: string): string | null };
  nextUrl?: { origin?: string } | null;
  /**
   * Absolute request URL. Used as a fallback when the runtime does not
   * provide a `nextUrl` (plain `Request` objects on the Edge runtime).
   */
  url?: string;
  /**
   * Pre-resolved origin of the request itself. Takes precedence over
   * `nextUrl.origin` and `url`.
   */
  requestOrigin?: string | null;
}

/**
 * Resolve the origin the request was made to.
 *
 * Precedence: an explicitly resolved origin, then `nextUrl.origin`, then the
 * origin of the absolute request URL. Forwarded headers are never consulted,
 * so a spoofed `x-forwarded-host` cannot turn a cross-origin request into a
 * same-origin one.
 */
function resolveRequestOrigin(request: CorsRequestLike): string | null {
  if (request.requestOrigin) {
    return request.requestOrigin;
  }

  if (request.nextUrl?.origin) {
    return request.nextUrl.origin;
  }

  if (request.url) {
    try {
      return new URL(request.url).origin;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Decide how a request's `Origin` header must be handled.
 *
 * Same-origin requests never consult the allowlist: browsers send `Origin`
 * on same-origin writes, and deployment URLs (for example Vercel preview
 * URLs) are frequently not listed in `ALLOWED_ORIGINS`.
 */
export function buildCorsDecision(
  request: CorsRequestLike,
  allowedOrigins: string[] | Set<string>,
): CorsDecision {
  const rawOrigin = request.headers.get('origin');

  if (!rawOrigin) {
    return { kind: 'none', origin: null };
  }

  const origin = rawOrigin.trim();

  if (!origin) {
    return { kind: 'none', origin: null };
  }

  if (isNullOrigin(origin)) {
    return { kind: 'null-origin', origin };
  }

  const requestOrigin = resolveRequestOrigin(request);

  if (isSameOrigin(origin, requestOrigin)) {
    return { kind: 'same-origin', origin };
  }

  if (isOriginAllowed(origin, allowedOrigins)) {
    return { kind: 'allowed', origin };
  }

  return { kind: 'denied', origin };
}
