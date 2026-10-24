/** @jest-environment node */
import { withCorrelationContext } from "@/app/lib/logger";
import { errorResponse, ErrorCode, type ErrorEnvelope } from "./server";

async function parseBody(res: ReturnType<typeof errorResponse>): Promise<ErrorEnvelope> {
  return res.json();
}

describe("errorResponse()", () => {
  it("returns the canonical { error: { code, message, request_id } } shape", async () => {
    const res = errorResponse(ErrorCode.NOT_FOUND, "Resource not found.", 404);
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

  it("sets the HTTP status code correctly", () => {
    const res = errorResponse(ErrorCode.BAD_REQUEST, "Bad input.", 400);
    expect(res.status).toBe(400);
  });

  it("defaults to HTTP 500 when no status is provided", () => {
    const res = errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops.");
    expect(res.status).toBe(500);
  });

  it("accepts arbitrary string codes (not just ErrorCode constants)", async () => {
    const res = errorResponse("CUSTOM_CODE", "Custom error.", 422);
    const body = await parseBody(res);
    expect(body.error.code).toBe("CUSTOM_CODE");
  });

  it("resolves request_id from withCorrelationContext", async () => {
    await withCorrelationContext({ request_id: "abc" }, async () => {
      const res = errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops.");
      const body = await parseBody(res);
      expect(body.error.request_id).toBe("abc");
    });
  });

  it("resolves request_id from explicit option", async () => {
    const res = errorResponse(ErrorCode.BAD_REQUEST, "Bad request.", 400, undefined, {
      requestId: "x1",
    });
    const body = await parseBody(res);
    expect(body.error.request_id).toBe("x1");
  });

  it("generates a req_ UUID format id when no context is provided", async () => {
    const res = errorResponse(ErrorCode.INTERNAL_SERVER_ERROR, "Oops.");
    const body = await parseBody(res);
    expect(body.error.request_id).toMatch(/^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
