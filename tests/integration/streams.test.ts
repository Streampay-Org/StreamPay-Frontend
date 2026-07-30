// Integration coverage for the public stream creation/listing route using the
// real route handlers and the in-memory persistence layer used in tests.
import { NextRequest } from "next/server";
import { GET as getStreams, POST as createStream } from "@/app/api/streams/route";
import { resetDb } from "@/app/lib/db";
import {
  InMemoryRateLimitStore,
  resetRateLimitStore,
  setRateLimitStore,
} from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting } from "@/app/lib/token-allowlist";

const VALID_STELLAR_KEY =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function makeRequest(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

describe("streams API integration", () => {
  let rateLimitStore: InMemoryRateLimitStore;

  beforeEach(() => {
    resetDb();
    _resetAllowlistForTesting();
    rateLimitStore = new InMemoryRateLimitStore(10_000);
    setRateLimitStore(rateLimitStore);
  });

  afterEach(() => {
    rateLimitStore.destroy();
    resetRateLimitStore();
  });

  it("lists streams and then exposes a newly created stream", async () => {
    const initialResponse = await getStreams(makeRequest("/api/streams"));

    expect(initialResponse.status).toBe(200);
    const initialBody = await initialResponse.json();
    expect(initialBody).toEqual(
      expect.objectContaining({
        links: { self: "/api/v1/streams?limit=20" },
      }),
    );
    expect(Array.isArray(initialBody.data)).toBe(true);
    expect(initialBody.meta).toEqual(
      expect.objectContaining({
        hasNext: false,
        nextCursor: null,
      }),
    );

    const createResponse = await createStream(
      makeRequest("/api/streams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rate: "50",
          recipient: VALID_STELLAR_KEY,
          schedule: "month",
        }),
      }),
    );

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    expect(createBody).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.stringMatching(/^stream-/),
          recipient: VALID_STELLAR_KEY,
          status: "draft",
          token: "XLM",
        }),
        links: { self: expect.stringContaining("/api/v1/streams/") },
      }),
    );

    const listResponse = await getStreams(makeRequest("/api/streams"));
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.meta.total).toBeGreaterThan(0);
    expect(listBody.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createBody.data.id,
          recipient: VALID_STELLAR_KEY,
          status: "draft",
        }),
      ]),
    );
  });

  it("returns the canonical validation error envelope for invalid stream payloads", async () => {
    const response = await createStream(
      makeRequest("/api/streams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient: "not-a-stellar-key", rate: "0", schedule: "invalid" }),
      }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: "One or more fields are invalid.",
        }),
      }),
    );
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details[0]).toEqual(
      expect.objectContaining({
        field: expect.any(String),
        code: expect.any(String),
        message: expect.any(String),
      }),
    );
  });

  it("returns a 400 error envelope when the request body is not valid JSON", async () => {
    const response = await createStream(
      makeRequest("/api/streams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Request body must be valid JSON",
      },
    });
  });
});
