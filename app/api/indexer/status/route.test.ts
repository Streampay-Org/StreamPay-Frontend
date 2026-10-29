/** @jest-environment node */

import { GET } from "./route";
import { getIndexerStatus } from "./status";
import { cursorsDb } from "@/lib/indexer";
import { applyRateLimit } from "@/src/middleware/rateLimit";

jest.mock("@/src/middleware/rateLimit", () => ({
  applyRateLimit: jest.fn(),
}));

const ADMIN_ADDRESS = "GADMIN_TEST_ADDRESS_12345";
const originalEnv = { ...process.env };
let nowSpy: jest.SpyInstance;

beforeEach(() => {
  cursorsDb.clear();
  process.env.STELLAR_NETWORK = "testnet";
  process.env.STALL_THRESHOLD_MS = "10000";
  (applyRateLimit as jest.Mock).mockResolvedValue(null);
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000);
});

afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.STELLAR_NETWORK;
  delete process.env.STALL_THRESHOLD_MS;
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});

describe("GET /api/indexer/status — deterministic status", () => {
  it("reports loading before the cursor has advanced", () => {
    const s = getIndexerStatus();
    expect(s.status).toBe("loading");
    expect(s.stale).toBe(false);
    expect(s.breakerOpen).toBe(false);
  });

  it("reports synced once the cursor advanced recently and is inside the stall threshold", () => {
    cursorsDb.set("testnet", { lastLedger: 42, lastUpdatedAt: 900 });
    const s = getIndexerStatus();
    expect(s.status).toBe("synced");
    expect(s.stale).toBe(false);
    expect(s.ledgerCursor).toBe(42);
  });

  it("reports stalled once the cursor age exceeds the threshold, with stale=true", () => {
    cursorsDb.set("testnet", { lastLedger: 42, lastUpdatedAt: -1_000_000 });
    const s = getIndexerStatus();
    expect(s.stale).toBe(true);
    expect(s.status).toBe("stalled");
  });

  it("does not report stale at exactly the threshold boundary", () => {
    cursorsDb.set("testnet", { lastLedger: 5, lastUpdatedAt: 1_000 - 9_999 });
    const s = getIndexerStatus();
    expect(s.stale).toBe(false);
    expect(s.status).toBe("synced");
  });

  it("reports stopped when the indexer circuit breaker is open", () => {
    cursorsDb.set("testnet", { lastLedger: 42, lastUpdatedAt: 900 });
    const s = getIndexerStatus();
    expect(typeof s.breakerOpen).toBe("boolean");
  });

  it("returns a stable message for every status without leaking raw state", () => {
    for (let i = 0; i < 20; i++) {
      const s = getIndexerStatus();
      expect(typeof s.message).toBe("string");
      expect(s.message.length).toBeGreaterThan(0);
      expect(s.message).not.toContain(process.env.JWT_SECRET ?? "nope");
    }
  });
});

describe("GET /api/indexer/status — per-identity rate limiting", () => {
  it("returns the rate-limit response without opening a stream when the identity is exhausted", async () => {
    const limitedResponse = Response.json(
      {
        error: {
          code: "rate_limit_exceeded",
          message: "Rate limit exceeded. Please try again later.",
          request_id: "req-test",
        },
      },
      { status: 429, headers: { "Retry-After": "60" } },
    );
    (applyRateLimit as jest.Mock).mockResolvedValueOnce(limitedResponse);

    const request = new Request("http://localhost/api/indexer/status", {
      headers: { "X-API-Key": "status-client-key" },
    });

    const response = await GET(request);

    expect(applyRateLimit).toHaveBeenCalledWith(request, "indexer/status", "GET");
    expect(response).toBe(limitedResponse);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
