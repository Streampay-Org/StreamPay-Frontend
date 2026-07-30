import { GET } from "./route";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import type { Stream } from "@/app/types/openapi";

describe("GET /api/streams/search", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();

    // Populate test store with controlled stream fixtures
    const store = getStore();
    store.streamRepository.streams.clear();

    const mockStreams: Stream[] = [
      {
        id: "stream-001",
        recipient: "Alice Smith",
        rate: "100 XLM/month",
        schedule: "Monthly",
        status: "active",
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-01T10:00:00Z",
        token: "XLM",
        email: "alice@example.com",
        label: "Q2 Engineering Retainer",
        memo: "Frontend work",
        senderAddress: "GBX123SENDER",
        partnerId: "PARTNER-ALPHA",
      },
      {
        id: "stream-002",
        recipient: "Bob Jones",
        rate: "50 USDC/month",
        schedule: "Monthly",
        status: "draft",
        createdAt: "2026-04-10T12:00:00Z",
        updatedAt: "2026-04-10T12:00:00Z",
        token: "USDC",
        email: "bob@example.com",
        label: "Design Audit",
        memo: "UI mockups review",
        senderAddress: "GBX456SENDER",
        partnerId: "PARTNER-BETA",
      },
      {
        id: "stream-003",
        recipient: "Charlie Brown",
        rate: "200 XLM/month",
        schedule: "Monthly",
        status: "ended",
        createdAt: "2026-04-20T15:00:00Z",
        updatedAt: "2026-04-25T10:00:00Z",
        token: "XLM",
        email: "charlie@example.com",
        label: "QA Testing",
        memo: "Regression test suite",
        senderAddress: "GBX123SENDER",
      },
    ];

    for (const s of mockStreams) {
      store.streamRepository.streams.set(s.id, s);
    }
  });

  afterEach(() => {
    resetRateLimitStore();
  });

  describe("Full-Text Search (q)", () => {
    it("returns all streams when query string is empty", async () => {
      const req = new Request("http://localhost/api/streams/search");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.meta.total).toBe(3);
      expect(json.data).toHaveLength(3);
    });

    it("searches across recipient, memo, label, email, and id", async () => {
      // Query matching recipient "Alice"
      const req1 = new Request("http://localhost/api/streams/search?q=Alice");
      const res1 = await GET(req1);
      const json1 = await res1.json();
      expect(json1.meta.total).toBe(1);
      expect(json1.data[0].id).toBe("stream-001");

      // Query matching memo "mockups"
      const req2 = new Request("http://localhost/api/streams/search?q=mockups");
      const res2 = await GET(req2);
      const json2 = await res2.json();
      expect(json2.meta.total).toBe(1);
      expect(json2.data[0].id).toBe("stream-002");

      // Query matching label "Engineering"
      const req3 = new Request("http://localhost/api/streams/search?q=Engineering");
      const res3 = await GET(req3);
      const json3 = await res3.json();
      expect(json3.meta.total).toBe(1);
      expect(json3.data[0].id).toBe("stream-001");

      // Query matching partnerId "PARTNER-BETA"
      const req4 = new Request("http://localhost/api/streams/search?q=PARTNER-BETA");
      const res4 = await GET(req4);
      const json4 = await res4.json();
      expect(json4.meta.total).toBe(1);
      expect(json4.data[0].id).toBe("stream-002");
    });

    it("handles multi-word search tokens (AND logic)", async () => {
      const req = new Request("http://localhost/api/streams/search?q=alice+frontend");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(1);
      expect(json.data[0].id).toBe("stream-001");
    });

    it("returns empty results when search query does not match", async () => {
      const req = new Request("http://localhost/api/streams/search?q=nonexistentterm");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(0);
      expect(json.data).toHaveLength(0);
    });
  });

  describe("Field Filtering", () => {
    it("filters by status", async () => {
      const req = new Request("http://localhost/api/streams/search?status=active");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(1);
      expect(json.data[0].status).toBe("active");
    });

    it("filters by asset/token", async () => {
      const req = new Request("http://localhost/api/streams/search?asset=USDC");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(1);
      expect(json.data[0].token).toBe("USDC");
    });

    it("filters by senderAddress", async () => {
      const req = new Request("http://localhost/api/streams/search?sender=GBX123SENDER");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(2);
    });

    it("filters by recipient", async () => {
      const req = new Request("http://localhost/api/streams/search?recipient=Charlie");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(1);
      expect(json.data[0].recipient).toBe("Charlie Brown");
    });
  });

  describe("Date Range Filtering (from / to)", () => {
    it("filters streams created after 'from' date", async () => {
      const req = new Request("http://localhost/api/streams/search?from=2026-04-05T00:00:00Z");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(2);
      expect(json.data.map((s: Stream) => s.id)).toEqual(["stream-003", "stream-002"]);
    });

    it("filters streams created before 'to' date", async () => {
      const req = new Request("http://localhost/api/streams/search?to=2026-04-15T00:00:00Z");
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(2);
      expect(json.data.map((s: Stream) => s.id)).toEqual(["stream-002", "stream-001"]);
    });

    it("filters streams within 'from' and 'to' date window", async () => {
      const req = new Request(
        "http://localhost/api/streams/search?from=2026-04-05T00:00:00Z&to=2026-04-15T00:00:00Z",
      );
      const res = await GET(req);
      const json = await res.json();
      expect(json.meta.total).toBe(1);
      expect(json.data[0].id).toBe("stream-002");
    });
  });

  describe("Pagination (limit / offset)", () => {
    it("respects custom limit and offset", async () => {
      const req = new Request("http://localhost/api/streams/search?limit=1&offset=1");
      const res = await GET(req);
      const json = await res.json();

      expect(json.meta.total).toBe(3);
      expect(json.meta.limit).toBe(1);
      expect(json.meta.offset).toBe(1);
      expect(json.meta.count).toBe(1);
      expect(json.data).toHaveLength(1);
    });
  });

  describe("Rate Limiting", () => {
    it("returns 429 when rate limit is exceeded", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 60,
        }),
      });

      const req = new Request("http://localhost/api/streams/search");
      const res = await GET(req);
      expect(res.status).toBe(429);
    });
  });

  describe("Boundary Input Validation & Error Envelope", () => {
    it("returns 400 for invalid status", async () => {
      const req = new Request("http://localhost/api/streams/search?status=invalid_status");
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Invalid status filter");
    });

    it("returns 400 for invalid 'from' date format", async () => {
      const req = new Request("http://localhost/api/streams/search?from=not-a-date");
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Invalid 'from' date format");
    });

    it("returns 400 for invalid 'to' date format", async () => {
      const req = new Request("http://localhost/api/streams/search?to=2026-99-99");
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Invalid 'to' date format");
    });

    it("returns 400 when 'from' date is after 'to' date", async () => {
      const req = new Request(
        "http://localhost/api/streams/search?from=2026-04-20T00:00:00Z&to=2026-04-10T00:00:00Z",
      );
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("'from' date parameter cannot be after 'to' date");
    });

    it("returns 400 for invalid limit boundary", async () => {
      const req = new Request("http://localhost/api/streams/search?limit=300");
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Invalid 'limit' parameter");
    });

    it("returns 400 for invalid offset boundary", async () => {
      const req = new Request("http://localhost/api/streams/search?offset=-5");
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Invalid 'offset' parameter");
    });

    it("includes request_id in error envelopes when correlation headers are present", async () => {
      const req = new Request("http://localhost/api/streams/search?status=bad", {
        headers: { "x-request-id": "test-req-id-123" },
      });
      const res = await GET(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.request_id).toBe("test-req-id-123");
    });
  });
});
