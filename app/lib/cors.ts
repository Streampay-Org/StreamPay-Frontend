/**
 * CORS allowlist helpers for browser-origin validation.
 *
 * The public API surface is protected by an explicit origin allowlist.
 * Wildcard `*` is permitted only in non-production environments.
 */

export const WILDCARD_ORIGIN = '*';

export const DEFAULT_CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const DEFAULT_CORS_HEADERS = 'authorization, content-type, x-requested-with, x-api-key, x-streampay-actor-id, x-streampay-actor-role';
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600;
export const MAX_CORS_MAX_AGE_SECONDS = 86400;

export function resolveCorsMaxAge(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_CORS_MAX_AGE_SECONDS;
  }

  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return DEFAULT_CORS_MAX_AGE_SECONDS;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CORS_MAX_AGE_SECONDS) {
    return DEFAULT_CORS_MAX_AGE_SECONDS;
  }

  return parsed;
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

  const url = new URL(origin);

  if (url.origin !== origin) {
    return url.origin;
  }

  return url.origin;
}

export function buildAllowedOriginSet(raw: string | undefined): Set<string> {
  return new Set(parseAllowedOrigins(raw).map(normalizeOrigin));
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
