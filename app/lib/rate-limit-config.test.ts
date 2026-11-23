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
  });
});
