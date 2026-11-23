/** @jest-environment node */

import jwt from "jsonwebtoken";
import { PUT } from "./route";

const TEST_SECRET = "test-secret-at-least-32-characters-long";
const WALLET_ADDRESS = "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";
const encoder = new TextEncoder();

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/app/lib/rate-limit", () => ({
  getClientIdentity: jest.fn(() => ({
    type: "wallet",
    value: WALLET_ADDRESS,
    displayValue: WALLET_ADDRESS,
  })),
  checkRateLimit: jest.fn(async () => ({ allowed: true, remaining: 10 })),
  rateLimitResponse: jest.fn(),
}));

jest.mock("@/app/lib/rate-limit-metrics", () => ({
  recordRequest: jest.fn(),
  recordThrottle: jest.fn(),
}));

jest.mock("@/app/lib/rate-limit-config", () => ({
  getLimitForRoute: jest.fn(() => "default"),
}));

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function makePutRequest(
  body: ReadableStream<Uint8Array> | null,
  token: string,
): Request {
  return {
    url: "http://localhost/api/notifications/preferences",
    method: "PUT",
    headers: new Headers({ authorization: `Bearer ${token}` }),
    body,
  } as unknown as Request;
}

function signToken(actorId: string): string {
  return jwt.sign(
    { iss: "streampay", aud: "streampay-api", sub: WALLET_ADDRESS, actorId },
    TEST_SECRET,
    { algorithm: "HS256", expiresIn: "15m" },
  );
}

describe("PUT /api/notifications/preferences body limits", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    jest.clearAllMocks();
  });

  it("accepts a chunked body under the limit", async () => {
    const response = await PUT(
      makePutRequest(
        streamFromChunks(['{"email":', "false}"]),
        signToken("actor-body-ok"),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preferences: { email: false },
    });
  });

  it("returns 413 for a chunked body over the limit", async () => {
    const response = await PUT(
      makePutRequest(
        streamFromChunks([new Uint8Array(300 * 1024)]),
        signToken("actor-body-large"),
      ),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "REQUEST_TOO_LARGE",
        request_id: expect.any(String),
      },
    });
  });

  it("returns 400 EMPTY_BODY for an empty body", async () => {
    const response = await PUT(
      makePutRequest(streamFromChunks([]), signToken("actor-body-empty")),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "EMPTY_BODY" },
    });
  });

  it("returns 400 INVALID_JSON for malformed JSON", async () => {
    const response = await PUT(
      makePutRequest(
        streamFromChunks(['{"email":']),
        signToken("actor-body-invalid"),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });

  it("returns 400 INVALID_JSON for invalid UTF-8", async () => {
    const response = await PUT(
      makePutRequest(
        streamFromChunks([new Uint8Array([0x7b, 0xff, 0x7d])]),
        signToken("actor-body-utf8"),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });
});
