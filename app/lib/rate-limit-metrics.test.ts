/**
 * @jest-environment node
 *
 * Rate-limit metric labels: route templates, bounded cardinality and redacted
 * identities.
 */

import {
  getMetrics,
  MAX_ROUTE_LABELS,
  normaliseRouteLabel,
  recordRequest,
  recordThrottle,
  redactIdentity,
  resetMetrics,
} from "@/app/lib/rate-limit-metrics";

beforeEach(() => {
  resetMetrics();
});

describe("normaliseRouteLabel", () => {
  it("collapses an id-like segment to :id", () => {
    expect(normaliseRouteLabel("/api/streams/str_123/pause")).toBe("/api/streams/:id/pause");
  });

  it("collapses a uuid segment to :id", () => {
    expect(
      normaliseRouteLabel("/api/orgs/0b7c9d2e-1111-2222-3333-444455556666/members"),
    ).toBe("/api/orgs/:id/members");
  });

  it("keeps a static route unchanged", () => {
    expect(normaliseRouteLabel("/api/activity")).toBe("/api/activity");
    expect(normaliseRouteLabel("/api/streams")).toBe("/api/streams");
  });

  it("collapses the stream id used by the app", () => {
    expect(normaliseRouteLabel("/api/streams/stream-1a2b3c4d")).toBe("/api/streams/:id");
    expect(normaliseRouteLabel("/api/streams/stream-1a2b3c4d/settle")).toBe(
      "/api/streams/:id/settle",
    );
  });

  it("maps an unknown route to other", () => {
    expect(normaliseRouteLabel("/not-an-api-route")).toBe("other");
    expect(normaliseRouteLabel("/api/unknown/thing")).toBe("other");
    expect(normaliseRouteLabel("")).toBe("other");
  });
});

describe("bounded cardinality", () => {
  it("keeps the counter map at or below the cap for 10 000 stream ids", () => {
    for (let index = 0; index < 10_000; index += 1) {
      recordRequest(`/api/streams/stream-${index}`);
    }

    const metrics = getMetrics();
    expect(Object.keys(metrics.total).length).toBeLessThanOrEqual(MAX_ROUTE_LABELS);
    expect(metrics.total["/api/streams/:id"]).toBe(10_000);
  });

  it("folds new routes into other once the cap is reached", () => {
    for (let index = 0; index < MAX_ROUTE_LABELS + 10; index += 1) {
      recordRequest(`/api/thing${index}`);
    }

    const metrics = getMetrics();
    expect(Object.keys(metrics.total).length).toBeLessThanOrEqual(MAX_ROUTE_LABELS);
    expect(metrics.total.other).toBeGreaterThan(0);
  });
});

describe("identity redaction", () => {
  it("redacts an IPv4 address to its /24 network", () => {
    expect(redactIdentity("ip", "203.0.113.45")).toBe("203.0.113.0/24");
  });

  it("redacts an IPv6 address to its /48 network", () => {
    expect(redactIdentity("ip", "2001:db8:85a3:0:0:8a2e:370:7334")).toBe(
      "2001:db8:85a3::/48",
    );
  });

  it("truncates a wallet address", () => {
    expect(
      redactIdentity(
        "wallet",
        "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA",
      ),
    ).toBe("GDSB...FSQA");
  });

  it("hashes an api key", () => {
    const redacted = redactIdentity("api_key", "sk_live_secret_value");
    expect(redacted).not.toContain("secret");
    expect(redacted).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});

describe("recordThrottle", () => {
  it("logs a redacted ip and a route template", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      recordThrottle("/api/streams/str_123/pause", "write", "ip", "203.0.113.45");

      const raw = String(warn.mock.calls[0][0]);
      const payload = JSON.parse(raw);

      expect(payload.route).toBe("/api/streams/:id/pause");
      expect(payload.identityDisplay).toBe("203.0.113.0/24");
      expect(raw).not.toContain("203.0.113.45");

      const metrics = getMetrics();
      expect(metrics.recentThrottles[0].identityDisplay).toBe("203.0.113.0/24");
    } finally {
      warn.mockRestore();
    }
  });
});