/** @jest-environment node */

import jwt from "jsonwebtoken";
import { DELETE } from "./route";
import { JWT_AUDIENCE, JWT_ISSUER, signToken } from "@/app/lib/auth";
import * as privacy from "@/app/lib/privacy";

const CURRENT_SECRET = "current-test-secret-at-least-32-characters-long";
const PREVIOUS_SECRET = "previous-test-secret-at-least-32-characters-long";
const WALLET_ADDRESS =
  "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";

function makeDeleteRequest(
  authorization?: string,
  requestId?: string,
): Request {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (requestId) {
    headers.set("x-request-id", requestId);
  }
  return new Request("http://localhost/api/identity/me/delete", {
    method: "DELETE",
    headers,
  });
}

describe("DELETE /api/identity/me/delete", () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPreviousSecret = process.env.JWT_PREVIOUS_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = CURRENT_SECRET;
    delete process.env.JWT_PREVIOUS_SECRET;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }

    if (originalPreviousSecret === undefined) {
      delete process.env.JWT_PREVIOUS_SECRET;
    } else {
      process.env.JWT_PREVIOUS_SECRET = originalPreviousSecret;
    }

    jest.restoreAllMocks();
  });

  it("returns 401 when authorization header is missing", async () => {
    const response = await DELETE(makeDeleteRequest(undefined, "req-missing-1"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid authorization header",
        request_id: "req-missing-1",
      },
    });
  });

  it("returns 401 when token is invalid or expired", async () => {
    const expiredToken = jwt.sign(
      { sub: WALLET_ADDRESS, iss: JWT_ISSUER, aud: JWT_AUDIENCE },
      CURRENT_SECRET,
      { algorithm: "HS256", expiresIn: "-1s" },
    );

    const response = await DELETE(
      makeDeleteRequest(`Bearer ${expiredToken}`, "req-expired-1"),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        request_id: "req-expired-1",
      },
    });
  });

  it("returns 202 with requestId, status, and completion_estimate for a valid token", async () => {
    const spy = jest.spyOn(privacy, "processDeletionRequest").mockResolvedValue({
      requestId: "dsr-test-123",
      status: "processing",
      scrubbedCount: 2,
    });

    const token = signToken(WALLET_ADDRESS);
    const response = await DELETE(makeDeleteRequest(`Bearer ${token}`));

    expect(response.status).toBe(202);
    expect(spy).toHaveBeenCalledWith(WALLET_ADDRESS);

    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        requestId: "dsr-test-123",
        status: "processing",
        scrubbedCount: 2,
        message: expect.stringContaining("30 days"),
        completion_estimate: expect.any(String),
      },
    });
    expect(Number.isNaN(Date.parse(body.data.completion_estimate))).toBe(false);
  });

  it("accepts tokens signed with a rotated previous secret (JWT_PREVIOUS_SECRET)", async () => {
    process.env.JWT_PREVIOUS_SECRET = PREVIOUS_SECRET;

    const spy = jest.spyOn(privacy, "processDeletionRequest").mockResolvedValue({
      requestId: "dsr-rotated-456",
      status: "processing",
      scrubbedCount: 0,
    });

    const rotatedToken = jwt.sign(
      { sub: WALLET_ADDRESS, iss: JWT_ISSUER, aud: JWT_AUDIENCE },
      PREVIOUS_SECRET,
      {
        algorithm: "HS256",
        expiresIn: "15m",
        header: { alg: "HS256", kid: "streampay-previous" },
      },
    );

    const response = await DELETE(makeDeleteRequest(`Bearer ${rotatedToken}`));

    expect(response.status).toBe(202);
    expect(spy).toHaveBeenCalledWith(WALLET_ADDRESS);
    const body = await response.json();
    expect(body.data.requestId).toBe("dsr-rotated-456");
  });

  it("maps internal errors from processDeletionRequest to 500 INTERNAL_ERROR", async () => {
    jest
      .spyOn(privacy, "processDeletionRequest")
      .mockRejectedValue(new Error("database unavailable"));

    const token = signToken(WALLET_ADDRESS);
    const response = await DELETE(
      makeDeleteRequest(`Bearer ${token}`, "req-fail-500"),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to process deletion request",
        request_id: "req-fail-500",
      },
    });
  });
});
