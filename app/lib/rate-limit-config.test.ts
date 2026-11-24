import { getLimitForRoute } from "./rate-limit-config";

describe("getLimitForRoute", () => {
  it.each([
    ["GET", "/api/v2/streams", "read"],
    ["GET", "/api/v2/streams/", "read"],
    ["GET", "/api/v2/streams/stream-123", "read"],
    ["GET", "/api/v2/streams/stream%2F123", "read"],
    ["GET", "/api/v2/streams/stream-123/activity/events", "read"],
    ["POST", "/api/v2/streams", "write"],
    ["POST", "/api/v2/streams/batch", "write"],
    ["POST", "/api/v2/streams/stream-123/update", "write"],
    ["POST", "/api/v2/streams/multi/group-123/pause", "write"],
    ["DELETE", "/api/v2/streams/stream-123", "write"],
    ["POST", "/api/streams/stream-123/cancel", "write"],
    ["POST", "/api/streams/stream-123/start", "write"],
    ["POST", "/api/streams/stream-123/resume", "write"],
    ["GET", "/api/audit", "read"],
    ["GET", "/api/audit/entries", "read"],
    ["GET", "/api/audit/export", "export"],
    ["GET", "/api/audit/archive", "export"],
    ["GET", "/api/exports", "export"],
    ["GET", "/api/exports/export-123", "export"],
  ] as const)("maps %s %s to %s", (method, path, expected) => {
    expect(getLimitForRoute(method, path)).toBe(expected);
  });

  it("preserves existing stream mappings", () => {
    expect(getLimitForRoute("GET", "/api/streams")).toBe("read");
    expect(getLimitForRoute("GET", "/api/streams/stream-123")).toBe("read");
    expect(getLimitForRoute("POST", "/api/streams/stream-123/pause")).toBe("write");
    expect(getLimitForRoute("POST", "/api/exports")).toBe("export");
  });

  it("respects method-specific mappings and falls back for unrelated paths", () => {
    expect(getLimitForRoute("POST", "/api/v2/streams/stream-123")).toBe("write");
    expect(getLimitForRoute("GET", "/api/v2/streams/stream-123")).toBe("read");
    expect(getLimitForRoute("PATCH", "/api/v2/streams/stream-123")).toBe("write");
    expect(getLimitForRoute("GET", "/api/unrelated")).toBe("read");
    expect(getLimitForRoute("POST", "/api/unrelated")).toBe("write");
import {
  RATE_LIMITS,
  ROUTE_LIMITS,
  getLimitForRoute,
  type LimitType,
} from "./rate-limit-config";

describe("getLimitForRoute", () => {
  describe("exact ROUTE_LIMITS entries", () => {
    const exactCases: Array<[method: string, path: string, expected: LimitType]> = [
      ["GET", "/api/reconciliation", "reconciliation"],
      ["GET", "/api/webhooks", "webhook"],
      ["POST", "/api/webhooks", "webhook"],
      ["GET", "/api/indexer/status", "read"],
      ["GET", "/api/indexer/sse", "read"],
      ["GET", "/api/streams", "read"],
      ["GET", "/api/streams/", "read"],
      ["GET", "/api/activity", "read"],
      ["GET", "/api/identity/me", "read"],
      ["POST", "/api/streams", "write"],
      ["POST", "/api/streams/batch", "write"],
      ["DELETE", "/api/streams/", "write"],
      ["POST", "/api/streams/*/start", "write"],
      ["POST", "/api/streams/*/pause", "write"],
      ["POST", "/api/streams/*/stop", "write"],
      ["POST", "/api/streams/*/settle", "write"],
      ["POST", "/api/streams/*/withdraw", "write"],
      ["POST", "/api/streams/*/webhooks/test", "write"],
      ["POST", "/api/exports", "export"],
    ];

    it("covers every key defined in ROUTE_LIMITS", () => {
      const testedKeys = exactCases.map(([method, path]) => `${method}:${path}`);
      expect(testedKeys.sort()).toEqual(Object.keys(ROUTE_LIMITS).sort());
    });

    it.each(exactCases)(
      "resolves %s %s to %s",
      (method, path, expected) => {
        expect(getLimitForRoute(method, path)).toBe(expected);
      },
    );
  });

  describe("middle-wildcard resolution", () => {
    const middleWildcardCases: Array<[method: string, path: string, expected: LimitType]> = [
      ["POST", "/api/streams/stream-123/start", "write"],
      ["POST", "/api/streams/stream-123/pause", "write"],
      ["POST", "/api/streams/stream-123/stop", "write"],
      ["POST", "/api/streams/stream-123/settle", "write"],
      ["POST", "/api/streams/stream-123/withdraw", "write"],
      ["POST", "/api/streams/abc/webhooks/test", "write"],
    ];

    it.each(middleWildcardCases)(
      "resolves %s %s to %s",
      (method, path, expected) => {
        expect(getLimitForRoute(method, path)).toBe(expected);
      },
    );
  });

  describe("end-wildcard resolution", () => {
    it("matches a trailing /* route pattern before falling back to defaults", () => {
      const syntheticKey = "GET:/api/custom-exports/*";
      ROUTE_LIMITS[syntheticKey] = "export";
      try {
        expect(getLimitForRoute("GET", "/api/custom-exports/report-42")).toBe("export");
      } finally {
        delete ROUTE_LIMITS[syntheticKey];
      }
    });
  });

  describe("default fallback resolution", () => {
    const defaultCases: Array<[method: string, path: string, expected: LimitType]> = [
      ["GET", "/api/unknown", "read"],
      ["GET", "/api/streams/stream-123", "read"],
      ["POST", "/api/unknown", "write"],
      ["DELETE", "/api/unknown", "write"],
      ["DELETE", "/api/streams/stream-123", "write"],
      ["PUT", "/api/streams/stream-123", "write"],
      ["PATCH", "/api/streams/stream-123", "write"],
    ];

    it.each(defaultCases)(
      "falls back for %s %s to %s",
      (method, path, expected) => {
        expect(getLimitForRoute(method, path)).toBe(expected);
      },
    );
  });

  describe("edge cases", () => {
    it("does not strip trailing slashes when matching exact routes", () => {
      expect(getLimitForRoute("GET", "/api/streams/")).toBe("read");
      expect(getLimitForRoute("POST", "/api/exports/")).toBe("write");
      expect(getLimitForRoute("GET", "/api/webhooks/")).toBe("read");
    });

    it("does not strip query strings from the path", () => {
      expect(getLimitForRoute("GET", "/api/reconciliation?limit=10")).toBe("read");
      expect(getLimitForRoute("POST", "/api/exports?format=csv")).toBe("write");
      expect(getLimitForRoute("GET", "/api/webhooks?since=123")).toBe("read");
    });

    it("is case-sensitive on the HTTP method", () => {
      expect(getLimitForRoute("get", "/api/reconciliation")).toBe("write");
      expect(getLimitForRoute("get", "/api/unknown")).toBe("write");
      expect(getLimitForRoute("post", "/api/exports")).toBe("write");
    });
  });

  describe("ROUTE_LIMITS configuration integrity", () => {
    it("maps every ROUTE_LIMITS value to a valid LimitType key of RATE_LIMITS", () => {
      const validKeys = new Set(Object.keys(RATE_LIMITS));
      for (const limitType of Object.values(ROUTE_LIMITS)) {
        expect(validKeys.has(limitType)).toBe(true);
        expect(RATE_LIMITS[limitType]).toBeDefined();
      }
    });
  });
});
