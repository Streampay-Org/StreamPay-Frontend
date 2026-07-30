/**
 * Focused tests verifying that POST and GET /api/exports emit structured
 * access-log entries via logAccessEvent for every response code path.
 *
 * Campaign: GrantFox FWC26 (Stellar Wave)
 */

import jwt from "jsonwebtoken";

// jest.mock is hoisted to the top by Babel/Jest. Using jest.fn() inside the
// factory avoids the "cannot access before initialization" TDZ error.
jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

// Retrieve the mock reference after the mock declaration.
import * as accessLogModule from "@/src/middleware/accessLog";
const mockLogAccessEvent = accessLogModule.logAccessEvent as jest.Mock;

import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { POST as createExport, GET as listExports } from "./route";

const JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

function makeToken(walletAddress: string, role = "user"): string {
  return jwt.sign(
    { sub: walletAddress, role, iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function authRequest(url: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(url, { headers });
}

describe("/api/exports — structured access logs", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    mockLogAccessEvent.mockClear();
  });

  // ── POST /api/exports ─────────────────────────────────────────────────────

  describe("POST /api/exports", () => {
    it("emits an access log entry on 401 (missing auth) with method, path, status and errorCode", async () => {
      await createExport(authRequest("http://localhost/api/exports"));

      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
      expect(mockLogAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/api/exports",
          status: 401,
          errorCode: "UNAUTHORIZED",
        }),
      );
    });

    it("does not include actorId in access log for unauthenticated 401", async () => {
      await createExport(authRequest("http://localhost/api/exports"));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(ctx).not.toHaveProperty("actorId");
    });

    it("emits access log with actorId and exportJobId on successful 201", async () => {
      const token = makeToken("GWALL1");
      await createExport(authRequest("http://localhost/api/exports", token));

      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(ctx).toMatchObject({
        method: "POST",
        path: "/api/exports",
        status: 201,
        actorId: "GWALL1",
      });
      expect(typeof ctx.exportJobId).toBe("string");
      expect(ctx.exportJobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("emits durationMs as a non-negative number on 201", async () => {
      const token = makeToken("GWALL1");
      await createExport(authRequest("http://localhost/api/exports", token));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(typeof ctx.durationMs).toBe("number");
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits exactly one access log entry per request", async () => {
      const token = makeToken("GWALL1");
      await createExport(authRequest("http://localhost/api/exports", token));
      await createExport(authRequest("http://localhost/api/exports", token));

      // Two separate requests → two separate log entries
      expect(mockLogAccessEvent).toHaveBeenCalledTimes(2);
    });

    it("emits access log with errorCode UNAUTHORIZED on invalid JWT", async () => {
      await createExport(authRequest("http://localhost/api/exports", "invalid.token.here"));

      expect(mockLogAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 401,
          errorCode: "UNAUTHORIZED",
        }),
      );
    });

    it("does not include exportJobId on failed (401) requests", async () => {
      await createExport(authRequest("http://localhost/api/exports"));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(ctx).not.toHaveProperty("exportJobId");
    });
  });

  // ── GET /api/exports ──────────────────────────────────────────────────────

  describe("GET /api/exports", () => {
    it("emits an access log entry on 401 (missing auth)", async () => {
      await listExports(authRequest("http://localhost/api/exports"));

      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
      expect(mockLogAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/api/exports",
          status: 401,
          errorCode: "UNAUTHORIZED",
        }),
      );
    });

    it("does not include actorId in access log for unauthenticated GET", async () => {
      await listExports(authRequest("http://localhost/api/exports"));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(ctx).not.toHaveProperty("actorId");
    });

    it("emits access log with actorId and status 200 on successful list", async () => {
      const token = makeToken("GWALL2");
      await listExports(authRequest("http://localhost/api/exports", token));

      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
      expect(mockLogAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/api/exports",
          status: 200,
          actorId: "GWALL2",
        }),
      );
    });

    it("does not include exportJobId in GET access log", async () => {
      const token = makeToken("GWALL2");
      await listExports(authRequest("http://localhost/api/exports", token));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(ctx).not.toHaveProperty("exportJobId");
    });

    it("emits durationMs as a non-negative number on 200", async () => {
      const token = makeToken("GWALL2");
      await listExports(authRequest("http://localhost/api/exports", token));

      const [ctx] = mockLogAccessEvent.mock.calls[0];
      expect(typeof ctx.durationMs).toBe("number");
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits access log for 304 (ETag not-modified) with actorId", async () => {
      const token = makeToken("GWALL2");

      // First request to capture the ETag
      const firstRes = await listExports(authRequest("http://localhost/api/exports", token));
      const etag = firstRes.headers.get("etag");

      mockLogAccessEvent.mockClear();

      // Conditional GET with matching ETag
      const conditionalReq = new Request("http://localhost/api/exports", {
        headers: {
          authorization: `Bearer ${token}`,
          "if-none-match": etag ?? "",
        },
      });
      const secondRes = await listExports(conditionalReq);

      expect(secondRes.status).toBe(304);
      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
      expect(mockLogAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/api/exports",
          status: 304,
          actorId: "GWALL2",
        }),
      );
    });
  });

  // ── Cross-cutting: correlation IDs are forwarded ──────────────────────────

  describe("correlation ID propagation", () => {
    it("access log entry does not throw when correlation context is absent", async () => {
      // No correlation middleware wrapping; context is undefined.
      await expect(
        createExport(authRequest("http://localhost/api/exports")),
      ).resolves.toBeDefined();

      expect(mockLogAccessEvent).toHaveBeenCalledTimes(1);
    });
  });
});
