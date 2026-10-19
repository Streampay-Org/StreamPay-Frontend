/** @jest-environment node */

import { POST } from "./route";
import { db, resetDb } from "@/app/lib/db";
import { eventBus } from "@/app/lib/event-bus";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

describe("POST /api/streams/batch/stop", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
  });

  it("stops multiple active streams successfully", async () => {
    const req = new Request("http://localhost/api/streams/batch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["stream-ada"]),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(db.streams.get("stream-ada")?.status).toBe("ended");
  });

  it("is atomic: rejects entire batch if one id is invalid state", async () => {
    // stream-yusuf is ended already in fixtures
    const req = new Request("http://localhost/api/streams/batch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["stream-ada", "stream-yusuf"]),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    // Ensure no streams were changed
    expect(db.streams.get("stream-ada")?.status).toBe("active");
  });

  it("publishes a redacted update for each stopped stream", async () => {
    const events: any[] = [];
    const listener = (data: any) => events.push(data);
    eventBus.on("stream:updated:stream-ada", listener);

    try {
      const req = new Request("http://localhost/api/streams/batch/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["stream-ada"]),
      });

      const res = await POST(req as any);
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("ended");
      expect(events[0]).not.toHaveProperty("email");
      expect(events[0]).not.toHaveProperty("label");
      expect(events[0]).not.toHaveProperty("memo");
      expect(events[0]).not.toHaveProperty("partnerId");
    } finally {
      eventBus.off("stream:updated:stream-ada", listener);
    }
  });

  it("replays cached response for same idempotency key and body", async () => {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "batch-stop-1" };
    const req1 = new Request("http://localhost/api/streams/batch/stop", { method: "POST", headers, body: JSON.stringify(["stream-ada"]) });
    const res1 = await POST(req1 as any);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    const req2 = new Request("http://localhost/api/streams/batch/stop", { method: "POST", headers, body: JSON.stringify(["stream-ada"]) });
    const res2 = await POST(req2 as any);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2).toEqual(data1);
  });
});
