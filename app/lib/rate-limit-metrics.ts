/**
 * Rate-limit metrics: bounded route labels and redacted identities.
 *
 * The counters used to be keyed by the raw request pathname, so every stream
 * id produced a new Prometheus time series and a new map entry. The maps grew
 * without bound and the label cardinality exploded. The counters are now keyed
 * by a route *template* and capped, and the identities that reach the logs are
 * redacted.
 */

import { createHash } from "crypto";
import { ROUTE_LIMITS } from "@/app/lib/rate-limit-config";

interface ThrottleEvent {
  route: string;
  limitType: string;
  timestamp: string;
  identityType: string;
  identityDisplay: string;
}

/** Maximum number of distinct route labels kept per counter map. */
export const MAX_ROUTE_LABELS = 200;

/** Label used for routes that cannot be mapped to a template. */
export const OTHER_ROUTE_LABEL = "other";

/**
 * Route templates derived from the `ROUTE_LIMITS` table.
 *
 * A `*` segment in the table is a wildcard for a single path segment and is
 * rendered as `:id`. A trailing `/` in the table means "the collection with an
 * id", e.g. `GET:/api/streams/` becomes `/api/streams/:id`.
 */
function buildRouteTemplates(): Set<string> {
  const templates = new Set<string>();

  for (const key of Object.keys(ROUTE_LIMITS)) {
    const path = key.slice(key.indexOf(":") + 1);
    const segments = path.split("/").filter(Boolean);
    const rendered = segments.map((segment) => (segment === "*" ? ":id" : segment));
    if (rendered.length === 0) {
      continue;
    }
    if (path.endsWith("/")) {
      rendered.push(":id");
    }
    templates.add(`/${rendered.join("/")}`);
  }

  return templates;
}

const ROUTE_TEMPLATES = buildRouteTemplates();

/** Segments that are always static, so they are never treated as an id. */
const STATIC_SEGMENTS = new Set<string>(
  Array.from(ROUTE_TEMPLATES).flatMap((template) =>
    template
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ":id"),
  ),
);

/**
 * Shapes that identify a single resource rather than a static route segment.
 * The patterns are anchored and simple, so matching them is O(segments) and
 * cannot backtrack.
 */
const ID_LIKE_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^G[A-Z0-9]{20,}$/, // Stellar account id
  /^\d+$/, // numeric id
  /^[a-z]{2,8}_[A-Za-z0-9-]+$/, // prefixed id, e.g. str_123
  /^[a-z][a-z0-9]*-[A-Za-z0-9-]+$/i, // prefixed id, e.g. stream-1a2b3c4d
  /^[0-9a-f]{16,}$/i, // long hex token
];

function isIdLikeSegment(segment: string): boolean {
  if (STATIC_SEGMENTS.has(segment)) {
    return false;
  }
  return ID_LIKE_PATTERNS.some((pattern) => pattern.test(segment));
}

/**
 * Maps a request pathname to the route template used as a metric label.
 *
 * Id-like segments (stream ids, org ids, UUIDs, numeric ids, ...) collapse to
 * `:id`. A path that matches a known route template keeps that template, a
 * path that only carries an id keeps its normalised shape, and anything else
 * is reported as `"other"` so the label set stays small.
 */
export function normaliseRouteLabel(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return OTHER_ROUTE_LABEL;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0 || segments[0] !== "api") {
    return OTHER_ROUTE_LABEL;
  }

  let replaced = false;
  const normalised = segments.map((segment) => {
    if (segment === ":id" || segment === "*") {
      return ":id";
    }
    if (isIdLikeSegment(segment)) {
      replaced = true;
      return ":id";
    }
    return segment;
  });

  const candidate = `/${normalised.join("/")}`;
  if (ROUTE_TEMPLATES.has(candidate)) {
    return candidate;
  }
  if (replaced) {
    return candidate;
  }
  return OTHER_ROUTE_LABEL;
}

/**
 * Salt used when hashing API keys. It is generated once per process, so the
 * hashes cannot be correlated across restarts or reversed with a precomputed
 * table.
 */
const IDENTITY_HASH_SALT = createHash("sha256")
  .update(`${process.pid}:${Math.random()}:${Date.now()}`)
  .digest("hex")
  .slice(0, 16);

/** Truncates an identifier to its first four and last four characters. */
function truncateIdentifier(value: string): string {
  const base = value.endsWith("...") ? value.slice(0, -3) : value;
  if (base.length <= 8) {
    return "...";
  }
  return `${base.slice(0, 4)}...${base.slice(-4)}`;
}

/** Redacts an IPv4 address to its /24 network, or an IPv6 address to its /48. */
export function redactIpAddress(ip: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  }

  if (ip.includes(":")) {
    const groups = ip.split(":");
    if (groups.length >= 3) {
      return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
    }
    return "::/48";
  }

  return "unknown";
}

/**
 * Redacts a client identity so neither the metrics nor the logs contain a
 * full address, wallet id or API key.
 */
export function redactIdentity(identityType: string, identityDisplay: string): string {
  if (identityType === "ip") {
    return redactIpAddress(identityDisplay);
  }

  if (identityType === "api_key") {
    const digest = createHash("sha256")
      .update(`${IDENTITY_HASH_SALT}:${identityDisplay}`)
      .digest("hex")
      .slice(0, 12);
    return `sha256:${digest}`;
  }

  return truncateIdentifier(identityDisplay);
}

const throttledCounters = new Map<string, number>();
const totalCounters = new Map<string, number>();
const recentThrottles: ThrottleEvent[] = [];
const MAX_RECENT_THROTTLES = 100;

/**
 * Increments a counter while keeping the label set bounded.
 *
 * Once the map holds `MAX_ROUTE_LABELS` entries, every new label is folded
 * into the `other` bucket. The oldest label is dropped to make room for that
 * bucket, so the map never grows past the cap.
 */
function bumpCounter(counters: Map<string, number>, key: string): void {
  if (counters.has(key)) {
    counters.set(key, (counters.get(key) ?? 0) + 1);
    return;
  }

  if (counters.size >= MAX_ROUTE_LABELS) {
    if (!counters.has(OTHER_ROUTE_LABEL)) {
      const oldest = counters.keys().next();
      if (!oldest.done) {
        counters.delete(oldest.value);
      }
    }
    bumpCounter(counters, OTHER_ROUTE_LABEL);
    return;
  }

  counters.set(key, 1);
}

export function recordThrottle(
  route: string,
  limitType: string,
  identityType: string,
  identityDisplay: string
): void {
  const label = normaliseRouteLabel(route);
  bumpCounter(throttledCounters, `${label}:${limitType}`);

  const event: ThrottleEvent = {
    route: label,
    limitType,
    timestamp: new Date().toISOString(),
    identityType,
    identityDisplay: redactIdentity(identityType, identityDisplay),
  };
  recentThrottles.push(event);
  if (recentThrottles.length > MAX_RECENT_THROTTLES) {
    recentThrottles.shift();
  }

  console.warn(
    JSON.stringify({
      event: "rate_limit_throttled",
      route: label,
      limitType,
      timestamp: event.timestamp,
      identityType,
      identityDisplay: event.identityDisplay,
    })
  );
}

export function recordRequest(route: string): void {
  bumpCounter(totalCounters, normaliseRouteLabel(route));
}

export function getMetrics(): {
  throttled: Record<string, number>;
  total: Record<string, number>;
  recentThrottles: ThrottleEvent[];
} {
  return {
    throttled: Object.fromEntries(throttledCounters),
    total: Object.fromEntries(totalCounters),
    recentThrottles: [...recentThrottles],
  };
}

export function resetMetrics(): void {
  throttledCounters.clear();
  totalCounters.clear();
  recentThrottles.length = 0;
}