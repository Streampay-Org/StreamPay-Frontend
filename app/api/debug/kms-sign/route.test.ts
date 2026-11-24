/** @jest-environment node */
import { POST } from "./route";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { NextResponse } from "next/server";

jest.mock("@/app/lib/internal-service-auth", () => ({
  requireInternalServiceAuth: jest.fn(),
}));

describe("KMS Debug Sign Route", () => {
  let originalNodeEnv: string | undefined;

  beforeAll(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterAll(() => {
    (process.env as any).NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (process.env as any).NODE_ENV = "development";
  });

  it("returns 404 error envelope in production", async () => {
    (process.env as any).NODE_ENV = "production";
    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({ payload: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found.");
  });

  it("returns 404 error envelope when internal auth fails", async () => {
    const mockAuthFailureResponse = NextResponse.json({ error: "Auth failed" }, { status: 404 });
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue(mockAuthFailureResponse);

    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({ payload: "hello" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found.");
  });

  it("signs request successfully when auth is valid", async () => {
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
      serviceName: "debug-client",
      keyId: "current",
      timestamp: new Date().toISOString(),
    });

    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({ payload: "hello world" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.signature).toBeDefined();
    expect(typeof body.signature).toBe("string");
  });

  it("returns 400 KMS_SIGN_INVALID_INPUT when payload is missing", async () => {
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
      serviceName: "debug-client",
    });

    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe("KMS_SIGN_INVALID_INPUT");
  });

  it("returns 400 KMS_SIGN_INVALID_INPUT when payload is empty", async () => {
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
      serviceName: "debug-client",
    });

    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({ payload: "" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe("KMS_SIGN_INVALID_INPUT");
  });

  it("returns 400 KMS_SIGN_INVALID_INPUT when payload is not a string", async () => {
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
      serviceName: "debug-client",
    });

    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: JSON.stringify({ payload: 12345 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe("KMS_SIGN_INVALID_INPUT");
  });

  it("returns 400 KMS_SIGN_INVALID_INPUT when body is not valid JSON object", async () => {
    (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
      serviceName: "debug-client",
    });

    // The route catches JSON parse errors and returns null body → triggers validation
    const request = new Request("http://localhost/api/debug/kms-sign", {
      method: "POST",
      body: "not-valid-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe("KMS_SIGN_INVALID_INPUT");
  });
});
