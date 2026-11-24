/** @jest-environment node */

import { POST as settlePOST } from "../[id]/settle/route";
import { POST as pausePOST } from "../[id]/pause/route";
import { resetDb, db } from "@/app/lib/db";
import { resetRateLimitStore, getRateLimitStore, InMemoryRateLimitStore } from "@/app/lib/rate-limit-store";

// Helper to create a NextRequest-like object
function createReq(url: string, method: string = "POST"): any {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Real-IP": "127.0.0.1",
      "Idempotency-Key": `idempotency-${Math.random().toString(36).slice(2)}`,
    },
  });
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

describe("Rate Limiting Consistency - Settle and Pause", () => {
  const STREAM_ID = "stream-ada";

  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    
    // Seed a stream for the tests to pass beyond RL if needed
    db.streams.set(STREAM_ID, {
      id: STREAM_ID,
      status: "active",
      recipient: "Ada Creative Studio",
      recipientAddress: "GCRE...ADA1",
      updatedAt: new Date().toISOString(),
    } as any);
  });

  afterEach(() => {
    const store = getRateLimitStore();
    if (store instanceof InMemoryRateLimitStore) {
      store.destroy();
    }
  });

  describe("Settle Endpoint Rate Limiting", () => {
    it("should return 429 when rate limit is exceeded for settle", async () => {
      // Exhaust the limit (10 for 'write' tier)
      for (let i = 0; i < 10; i++) {
        db.streams.set(STREAM_ID, { id: STREAM_ID, status: "active", recipient: "Ada", updatedAt: new Date().toISOString() } as any);
        await settlePOST(createReq(`http://localhost/api/streams/${STREAM_ID}/settle`), ctx(STREAM_ID));
      }

      // The 11th request should be rate limited
      const req = createReq(`http://localhost/api/streams/${STREAM_ID}/settle`);
      const res = await settlePOST(req, ctx(STREAM_ID));
      
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });

    it("should allow request when under limit for settle", async () => {
      const req = createReq(`http://localhost/api/streams/${STREAM_ID}/settle`);
      
      const res = await settlePOST(req, ctx(STREAM_ID));
      
      // Should not be 429. It might be 502 (settlement client fail) or 200/409 etc, 
      // but NOT 429.
      expect(res.status).not.toBe(429);
    });
  });

  describe("Pause Endpoint Rate Limiting", () => {
    it("should return 429 when rate limit is exceeded for pause", async () => {
      // Exhaust the limit (10 for 'write' tier)
      for (let i = 0; i < 10; i++) {
        db.streams.set(STREAM_ID, { id: STREAM_ID, status: "active", recipient: "Ada", updatedAt: new Date().toISOString() } as any);
        await pausePOST(createReq(`http://localhost/api/streams/${STREAM_ID}/pause`), ctx(STREAM_ID));
      }

      // The 11th request should be rate limited
      const req = createReq(`http://localhost/api/streams/${STREAM_ID}/pause`);
      const res = await pausePOST(req, ctx(STREAM_ID));
      
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });

    it("should allow request when under limit for pause", async () => {
      const req = createReq(`http://localhost/api/streams/${STREAM_ID}/pause`);
      
      const res = await pausePOST(req, ctx(STREAM_ID));
      
      // Should not be 429.
      expect(res.status).not.toBe(429);
    });
  });
});
