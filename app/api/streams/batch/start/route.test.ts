/** @jest-environment node */

import { POST } from "./route";
import { db, resetDb } from "@/app/lib/db";
import { eventBus } from "@/app/lib/event-bus";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

describe("POST /api/streams/batch/start", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
  });

  it("starts multiple draft streams successfully", async () => {
    const req = new Request("http://localhost/api/streams/batch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["stream-kemi", "stream-ada"]),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(db.streams.get("stream-kemi")?.status).toBe("active");
    expect(db.streams.get("stream-ada")?.status).toBe("active");
  });

  it("is atomic: rejects entire batch if one id is missing", async () => {
    const req = new Request("http://localhost/api/streams/batch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["stream-kemi", "stream-missing"]),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    // Ensure no streams were changed
    expect(db.streams.get("stream-kemi")?.status).not.toBe("active");
  });

  it("publishes only for streams that actually changed", async () => {
    const published: Record<string, any[]> = { "stream-ada": [], "stream-kemi": [] };
    const listeners = Object.keys(published).map((id) => {
      const listener = (data: any) => published[id].push(data);
      eventBus.on(`stream:updated:${id}`, listener);
      return { id, listener };
    });

    try {
      const req = new Request("http://localhost/api/streams/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["stream-ada", "stream-kemi"]),
      });

      const res = await POST(req as any);
      expect(res.status).toBe(200);
      // stream-ada is already active (no-op); stream-kemi is draft → active.
      expect(published["stream-ada"]).toHaveLength(0);
      expect(published["stream-kemi"]).toHaveLength(1);
      expect(published["stream-kemi"][0].status).toBe("active");
      expect(published["stream-kemi"][0]).not.toHaveProperty("email");
      expect(published["stream-kemi"][0]).not.toHaveProperty("memo");
    } finally {
      for (const { id, listener } of listeners) {
        eventBus.off(`stream:updated:${id}`, listener);
      }
    }
  });

  it("replays cached response for same idempotency key and body", async () => {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "batch-start-1" };
    const req1 = new Request("http://localhost/api/streams/batch/start", { method: "POST", headers, body: JSON.stringify(["stream-kemi"]) });
    const res1 = await POST(req1 as any);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    const req2 = new Request("http://localhost/api/streams/batch/start", { method: "POST", headers, body: JSON.stringify(["stream-kemi"]) });
    const res2 = await POST(req2 as any);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2).toEqual(data1);
  });
});
