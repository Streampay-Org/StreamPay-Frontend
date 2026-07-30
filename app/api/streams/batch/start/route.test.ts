/** @jest-environment node */

import { POST } from "./route";
import { db, resetDb } from "@/app/lib/db";
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
