import { RATE_LIMITS, ROUTE_LIMITS } from "@/app/lib/rate-limit-config";

interface ThrottleEvent {
  route: string;
  limitType: string;
  timestamp: string;
  identityType: string;
  identityDisplay: string;
}

const throttledCounters = new Map<string, number>();
const totalCounters = new Map<string, number>();
const recentThrottles: ThrottleEvent[] = [];
const MAX_RECENT_THROTTLES = 100;
export const MAX_METRIC_LABELS = 200;
const knownLimitTypes = new Set([...Object.keys(RATE_LIMITS), "challenge", "login"]);

const routePatterns = [...new Set([
  ...Object.keys(ROUTE_LIMITS).map((key) => key.slice(key.indexOf(":") + 1)),
  // These registered routes have path parameters but are not rate-limit
  // overrides in ROUTE_LIMITS.
  "/api/streams/search",
  "/api/streams/preview",
  "/api/streams/*/cancel",
  "/api/streams/*",
  "/api/orgs/*",
  "/api/orgs/*/audit",
  "/api/orgs/*/members",
  "/api/orgs/*/token-allowlist",
])].sort((a, b) => (a.match(/\*/g)?.length ?? 0) - (b.match(/\*/g)?.length ?? 0));

/**
 * Convert a request pathname to a stable, bounded Prometheus label. Only
 * routes represented in ROUTE_LIMITS are admitted; parameter segments are
 * matched against those templates rather than copied into metric labels.
 */
export function normaliseRouteLabel(pathname: string): string {
  const path = pathname.split("?", 1)[0].replace(/\/$/, "") || "/";
  for (const pattern of routePatterns) {
    const template = pattern.endsWith("/") ? `${pattern}*` : pattern;
    const expected = template.split("/").filter(Boolean);
    const actual = path.split("/").filter(Boolean);
    if (expected.length !== actual.length) continue;
    let matched = true;
    const label: string[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] === "*") {
        label.push(":id");
      } else if (expected[i] === actual[i]) {
        label.push(actual[i]);
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return `/${label.join("/")}`;
  }
  return "other";
}

/** Remove personal identifiers from throttle logs and retained events. */
export function redactRateLimitIdentity(identityType: string, display: string): string {
  if (identityType.toLowerCase() === "ip") {
    const ipv4 = display.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)) {
      return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
    }
    if (display.includes(":")) {
      const [left = "", right = ""] = display.split("::");
      const leftParts = left ? left.split(":") : [];
      const rightParts = right ? right.split(":") : [];
      const groups = [...leftParts, ...Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill("0"), ...rightParts];
      if (groups.length === 8 && groups.every((part) => /^[0-9a-f]{0,4}$/i.test(part))) {
        return `${groups.slice(0, 3).join(":")}::/48`;
      }
    }
    return "[redacted]";
  }
  if (identityType.toLowerCase().includes("wallet")) {
    return display.length > 8 ? `${display.slice(0, 4)}…${display.slice(-4)}` : "[redacted]";
  }
  return "[redacted]";
}

function incrementBounded(map: Map<string, number>, key: string, fallbackKey: string, reserve: number): void {
  if (map.has(key)) {
    map.set(key, (map.get(key) || 0) + 1);
    return;
  }
  const target = map.size < MAX_METRIC_LABELS - reserve ? key : fallbackKey;
  map.set(target, (map.get(target) || 0) + 1);
}

export function recordThrottle(
  route: string,
  limitType: string,
  identityType: string,
  identityDisplay: string
): void {
  const routeLabel = normaliseRouteLabel(route);
  const safeLimitType = knownLimitTypes.has(limitType) ? limitType : "other";
  const key = `${routeLabel}:${safeLimitType}`;
  incrementBounded(throttledCounters, key, `other:${safeLimitType}`, knownLimitTypes.size + 1);
  const safeIdentity = redactRateLimitIdentity(identityType, identityDisplay);

  const event: ThrottleEvent = {
    route: routeLabel,
    limitType: safeLimitType,
    timestamp: new Date().toISOString(),
    identityType,
    identityDisplay: safeIdentity,
  };
  recentThrottles.push(event);
  if (recentThrottles.length > MAX_RECENT_THROTTLES) {
    recentThrottles.shift();
  }

  console.warn(
    JSON.stringify({
      event: "rate_limit_throttled",
      route: routeLabel,
      limitType: safeLimitType,
      timestamp: event.timestamp,
      identityType,
      identityDisplay: safeIdentity,
    })
  );
}

export function recordRequest(route: string): void {
  const routeLabel = normaliseRouteLabel(route);
  incrementBounded(totalCounters, routeLabel, "other", 1);
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
