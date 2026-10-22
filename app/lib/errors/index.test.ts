/**
 * @jest-environment node
 */
import { errorResponse, ErrorCode, type ErrorEnvelope } from "./server";
import { withCorrelationContext } from "@/app/lib/logger";

function parseBody(res: Awaited<ReturnType<typeof errorResponse>>): Promise<ErrorEnvelope> {
  return res.json();
}

describe("errorResponse()", () => {
  it("returns the canonical { error: { code, message, request_id } } shape", async () => {
    const res = await errorResponse(ErrorCode.NOT_FOUND, "Resource not found.", 404);
    const body = await parseBody(res);

    expect(body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
      },
    });
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
  });

  it("sets the HTTP status code correctly", async () => {
    const res = await errorResponse(ErrorCode.BAD_REQUEST, "Bad input.", 400);
    expect(res.status).toBe(400);
  });

  it("defaults to HTTP 500 when no status is provided", async () => {
    const res = await errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops.");
    expect(res.status).toBe(500);
  });

  it("accepts arbitrary string codes (not just ErrorCode constants)", async () => {
    const res = await errorResponse("CUSTOM_CODE", "Custom error.", 422);
    const body = await parseBody(res);
    expect(body.error.code).toBe("CUSTOM_CODE");
  });

  it("always includes a request_id outside a request context", async () => {
    const body = await parseBody(await errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops."));
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
  });

  it("uses the correlation context request id when present", async () => {
    const body = await withCorrelationContext(
      {
        request_id: "req_ctx_123",
        correlation_id: "req_ctx_123",
      },
      async () => parseBody(await errorResponse(ErrorCode.NOT_FOUND, "Not found.", 404)),
    );

    expect(body.error.request_id).toBe("req_ctx_123");
  });

  it("prefers an explicit request id over the correlation context", async () => {
    const body = await withCorrelationContext(
      {
        request_id: "req_ctx_123",
        correlation_id: "req_ctx_123",
      },
      async () =>
        parseBody(
          await errorResponse(ErrorCode.NOT_FOUND, "Not found.", 404, undefined, {
            requestId: "req_explicit",
          }),
        ),
    );

    expect(body.error.request_id).toBe("req_explicit");
  });

  it("falls back to a generated request id with the req_ prefix", async () => {
    const body = await parseBody(await errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops."));
    expect(body.error.request_id).toMatch(/^req_/);
  });
});
