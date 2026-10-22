/**
 * CORS allowlist helpers for browser-origin validation.
 *
 * The public API surface is protected by an explicit origin allowlist.
 * Wildcard `*` is permitted only in non-production environments.
 */

export const WILDCARD_ORIGIN = '*';

export const DEFAULT_CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const DEFAULT_CORS_HEADERS = 'authorization, content-type, x-requested-with, x-api-key, x-streampay-actor-id, x-streampay-actor-role';
export const DEFAULT_CORS_EXPOSE_HEADERS = 'x-request-id, retry-after, etag';
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600;

export type CorsDecisionKind = 'same-origin' | 'allowed' | 'denied' | 'null-origin' | 'none';

export interface CorsDecision {
  kind: CorsDecisionKind;
  origin?: string;
}

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

  try {
    return new URL(origin).origin;
  } catch {
    return origin.toLowerCase();
  }
}

export function buildAllowedOriginSet(raw: string | undefined): Set<string> {
  return new Set(parseAllowedOrigins(raw).map(normalizeOrigin));
}

export function mergeVaryHeader(headers: Headers, value: string): void {
  const current = headers.get('Vary');
  if (!current) {
    headers.set('Vary', value);
    return;
  }

  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set('Vary', `${current}, ${value}`);
  }
}

export function buildCorsHeaders(origin: string): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', DEFAULT_CORS_METHODS);
  headers.set('Access-Control-Allow-Headers', DEFAULT_CORS_HEADERS);
  headers.set('Access-Control-Max-Age', String(DEFAULT_CORS_MAX_AGE_SECONDS));
  headers.set('Access-Control-Expose-Headers', DEFAULT_CORS_EXPOSE_HEADERS);
  headers.set('Vary', 'Origin');
  return headers;
}

export function isOriginAllowed(origin: string | null | undefined, allowedOrigins: string[] | Set<string>): boolean {
  if (!origin || origin.trim().toLowerCase() === 'null') {
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

export function buildCorsDecision(
  request: {
    headers?: Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };
    url?: string;
    nextUrl?: { origin?: string; host?: string; hostname?: string; protocol?: string };
  },
  allowedOrigins: string[] | Set<string>,
  options?: { trustProxy?: boolean }
): CorsDecision {
  const getHeader = (name: string): string | null => {
    if (!request.headers) return null;
    if (typeof (request.headers as Headers).get === 'function') {
      return (request.headers as Headers).get(name);
    }
    const rec = request.headers as Record<string, string | string[] | undefined>;
    const val = rec[name] ?? rec[name.toLowerCase()];
    if (Array.isArray(val)) return val[0] ?? null;
    return val ?? null;
  };

  const originHeader = getHeader('origin');
  if (originHeader === null || originHeader === undefined || originHeader.trim() === '') {
    return { kind: 'none' };
  }

  const trimmedOrigin = originHeader.trim();
  if (trimmedOrigin.toLowerCase() === 'null') {
    return { kind: 'null-origin', origin: 'null' };
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(trimmedOrigin).origin;
  } catch {
    return { kind: 'denied', origin: trimmedOrigin };
  }

  const trustProxy =
    options?.trustProxy ??
    (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1');

  let requestOrigin: string | null = null;

  if (trustProxy) {
    const forwardedHost = getHeader('x-forwarded-host');
    if (forwardedHost) {
      const host = forwardedHost.split(',')[0].trim();
      const proto = getHeader('x-forwarded-proto')?.split(',')[0].trim() || 'https';
      try {
        requestOrigin = new URL(`${proto}://${host}`).origin;
      } catch {
        // Fall back if forwarded host cannot be parsed
      }
    }
  }

  if (!requestOrigin) {
    if (request.nextUrl?.origin) {
      try {
        requestOrigin = new URL(request.nextUrl.origin).origin;
      } catch {
        requestOrigin = request.nextUrl.origin;
      }
    } else if (request.url) {
      try {
        requestOrigin = new URL(request.url).origin;
      } catch {
        // Fall back if url cannot be parsed
      }
    }
  }

  if (requestOrigin && normalizedOrigin.toLowerCase() === requestOrigin.toLowerCase()) {
    return { kind: 'same-origin', origin: normalizedOrigin };
  }

  if (isOriginAllowed(normalizedOrigin, allowedOrigins)) {
    return { kind: 'allowed', origin: normalizedOrigin };
  }

  return { kind: 'denied', origin: normalizedOrigin };
}
