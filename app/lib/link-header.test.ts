import { buildLinkHeader, buildUrlWithParams } from "./link-header";

describe("buildLinkHeader", () => {
  it("emits RFC 8288 rel=\"next\" with quoted rel and preserved query params", () => {
    const header = buildLinkHeader({
      baseUrl: "/api/v2/streams",
      params: { limit: 20, status: "active" },
      next: "abc123",
    });

    expect(header).toBe('</api/v2/streams?limit=20&status=active&cursor=abc123>; rel="next"');
  });

  it("URL-encodes cursor characters such as +, /, and =", () => {
    const cursor = "MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafHN0cmVhbS0x+a/b==";
    const header = buildLinkHeader({
      baseUrl: "/api/v2/streams",
      params: { limit: 10 },
      next: cursor,
    });

    expect(header).toBe(
      `</api/v2/streams?limit=10&cursor=${encodeURIComponent(cursor)}>; rel="next"`,
    );
  });

  it("emits next, prev, and self in order when all are provided", () => {
    const header = buildLinkHeader({
      baseUrl: "/api/v2/streams",
      params: { limit: 20, cursor: "cur-2" },
      next: "cur-3",
      prev: "cur-1",
      self: true,
    });

    expect(header).toBe(
      '</api/v2/streams?limit=20&cursor=cur-3>; rel="next", ' +
        '</api/v2/streams?limit=20&cursor=cur-1>; rel="prev", ' +
        '</api/v2/streams?limit=20&cursor=cur-2>; rel="self"',
    );
  });

  it("supports URLSearchParams input and preserves all filters", () => {
    const params = new URLSearchParams({
      limit: "50",
      streamId: "stream-ada",
      type: "stream.created",
      from: "2026-04-01",
    });

    const header = buildLinkHeader({
      baseUrl: "/api/activity",
      params,
      next: "next+cursor=",
      self: true,
    });

    expect(header).toContain('rel="next"');
    expect(header).toContain('rel="self"');
    expect(header).toContain("streamId=stream-ada");
    expect(header).toContain("type=stream.created");
    expect(header).toContain("from=2026-04-01");
    expect(header).toContain("cursor=next%2Bcursor%3D");
  });

  it("omits rel=\"next\" when next is null or undefined", () => {
    const header = buildLinkHeader({
      baseUrl: "/api/v2/streams",
      params: { limit: 100 },
      next: null,
      self: true,
    });

    expect(header).toBe('</api/v2/streams?limit=100>; rel="self"');
  });

  it("returns null when no link relations are provided", () => {
    expect(
      buildLinkHeader({
        baseUrl: "/api/v2/streams",
        params: { limit: 20 },
      }),
    ).toBeNull();
  });

  it("accepts an explicit URI string for self", () => {
    const header = buildLinkHeader({
      baseUrl: "/api/streams",
      params: { limit: 20 },
      self: "/api/v1/streams?limit=20&status=draft",
    });

    expect(header).toBe('</api/v1/streams?limit=20&status=draft>; rel="self"');
  });
});

describe("buildUrlWithParams", () => {
  it("omits query string when params are empty", () => {
    expect(buildUrlWithParams("/api/streams", {})).toBe("/api/streams");
  });

  it("skips null, undefined, and empty-string params", () => {
    expect(
      buildUrlWithParams("/api/streams", {
        limit: 20,
        status: null,
        cursor: undefined,
        empty: "",
      }),
    ).toBe("/api/streams?limit=20");
  });
});
