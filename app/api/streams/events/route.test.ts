import { GET } from "./route";
import { db, resetDb } from "@/app/lib/db";
import { eventBus } from "@/app/lib/event-bus";
import jwt from "jsonwebtoken";

// Mock dependencies
jest.mock("../../../lib/logger");

const JWT_SECRET = process.env.JWT_SECRET || "streampay-dev-secret-do-not-use-in-prod";

describe("SSE Events API", () => {
  beforeEach(() => {
    // We need to import db correctly
    const { db: actualDb, resetDb: actualResetDb } = require("@/app/lib/db");
    actualResetDb();
  });

  it("returns 401 if no token is provided", async () => {
    const req = new Request("http://localhost/api/streams/events?streamId=stream-ada") as any;
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 422 if streamId is missing", async () => {
    const token = jwt.sign({ iss: "streampay", aud: "streampay-api", sub: "GD7H...3J4K", role: "user" }, JWT_SECRET);
    const req = new Request("http://localhost/api/streams/events", {
      headers: { authorization: `Bearer ${token}` },
    }) as any;
    const res = await GET(req);
    expect(res.status).toBe(422);
  });

  it("returns 404 if stream does not exist", async () => {
    const token = jwt.sign({ iss: "streampay", aud: "streampay-api", sub: "GD7H...3J4K", role: "user" }, JWT_SECRET);
    const req = new Request("http://localhost/api/streams/events?streamId=invalid-id", {
      headers: { authorization: `Bearer ${token}` },
    }) as any;
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("returns 403 if user does not own the stream", async () => {
    // stream-ada belongs to ada@creativestudio.io (GD7H...3J4K)
    // We'll use a different wallet address
    const token = jwt.sign({ iss: "streampay", aud: "streampay-api", sub: "OTHER_WALLET", role: "user" }, JWT_SECRET);
    const req = new Request("http://localhost/api/streams/events?streamId=stream-ada", {
      headers: { authorization: `Bearer ${token}` },
    }) as any;
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns 200 and establishes SSE for authorized user", async () => {
    const token = jwt.sign({ iss: "streampay", aud: "streampay-api", sub: "GD7H...3J4K", role: "user" }, JWT_SECRET);
    const req = new Request("http://localhost/api/streams/events?streamId=stream-ada", {
      headers: { authorization: `Bearer ${token}` },
    }) as any;
    
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  // ── Bounded heartbeats & dead-client detection (issue #1372) ─────────────

  function authorizedRequest(signal?: AbortSignal) {
    const token = jwt.sign(
      { iss: "streampay", aud: "streampay-api", sub: "GD7H...3J4K", role: "user" },
      JWT_SECRET,
    );
    return new Request("http://localhost/api/streams/events?streamId=stream-ada", {
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    }) as any;
  }

  it("emits bounded heartbeats then closes the stream", async () => {
    const prevInterval = process.env.SSE_HEARTBEAT_INTERVAL_MS;
    const prevMax = process.env.SSE_HEARTBEAT_MAX;
    const prevIdle = process.env.SSE_MAX_IDLE_MS;
    process.env.SSE_HEARTBEAT_INTERVAL_MS = "10";
    process.env.SSE_HEARTBEAT_MAX = "2";
    process.env.SSE_MAX_IDLE_MS = "0";
    jest.useFakeTimers();

    try {
      const res = await GET(authorizedRequest());
      expect(res.status).toBe(200);

      const bodyPromise = res.text();
      jest.advanceTimersByTime(10); // heartbeat 1
      jest.advanceTimersByTime(10); // heartbeat 2
      jest.advanceTimersByTime(10); // bound reached → close

      const body = await bodyPromise;
      const heartbeats = body.match(/: heartbeat \d/g) ?? [];
      expect(heartbeats).toHaveLength(2);
    } finally {
      jest.useRealTimers();
      if (prevInterval === undefined) {
        delete process.env.SSE_HEARTBEAT_INTERVAL_MS;
      } else {
        process.env.SSE_HEARTBEAT_INTERVAL_MS = prevInterval;
      }
      if (prevMax === undefined) {
        delete process.env.SSE_HEARTBEAT_MAX;
      } else {
        process.env.SSE_HEARTBEAT_MAX = prevMax;
      }
      if (prevIdle === undefined) {
        delete process.env.SSE_MAX_IDLE_MS;
      } else {
        process.env.SSE_MAX_IDLE_MS = prevIdle;
      }
    }
  });

  it("closes the stream when the client disconnects (abort)", async () => {
    const abortController = new AbortController();
    const res = await GET(authorizedRequest(abortController.signal));
    expect(res.status).toBe(200);

    const bodyPromise = res.text();
    abortController.abort();

    // No data events were emitted; the stream closes cleanly on abort.
    await expect(bodyPromise).resolves.toBe("");
  });
});
