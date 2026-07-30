import { logAccessEvent } from "./accessLog";
import { getCorrelationContext, logger } from "@/app/lib/logger";

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(),
  logger: { info: jest.fn() },
}));

describe("logAccessEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Original tests (preserved) ─────────────────────────────────────────────

  it("logs a generic access message with the caller's context", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({ method: "GET", path: "/api/streams", status: 200, durationMs: 12 });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ method: "GET", path: "/api/streams", status: 200, durationMs: 12 }),
    );
  });

  it("does not hardcode a route-specific message", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({ method: "POST", path: "/api/streams", status: 201 });

    const [message] = (logger.info as jest.Mock).mock.calls[0];
    expect(message).not.toMatch(/wallet/i);
  });

  it("attaches correlation, request and trace identifiers when present", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue({
      request_id: "req-1",
      correlation_id: "corr-1",
      traceparent: "00-trace-1",
    });

    logAccessEvent({ method: "GET", path: "/api/streams", status: 200 });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({
        request_id: "req-1",
        correlation_id: "corr-1",
        traceparent: "00-trace-1",
      }),
    );
  });

  it("passes through arbitrary extra fields (e.g. errorCode)", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({
      method: "GET",
      path: "/api/streams",
      status: 429,
      errorCode: "rate_limit_exceeded",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ errorCode: "rate_limit_exceeded" }),
    );
  });

  // ── New tests for actorId and export-specific fields ───────────────────────

  it("includes actorId when provided", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 201,
      actorId: "GACTORWALLET123",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ actorId: "GACTORWALLET123" }),
    );
  });

  it("omits actorId field when not provided (anonymous request)", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({ method: "POST", path: "/api/exports", status: 401 });

    const [, payload] = (logger.info as jest.Mock).mock.calls[0];
    expect(payload).not.toHaveProperty("actorId");
  });

  it("includes exportJobId when provided", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 201,
      actorId: "GOWNER1",
      exportJobId: jobId,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ exportJobId: jobId }),
    );
  });

  it("omits exportJobId when not provided", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({ method: "GET", path: "/api/exports", status: 200, actorId: "GOWNER1" });

    const [, payload] = (logger.info as jest.Mock).mock.calls[0];
    expect(payload).not.toHaveProperty("exportJobId");
  });

  it("includes durationMs in the log entry", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({ method: "GET", path: "/api/exports", status: 200, durationMs: 42.5 });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ durationMs: 42.5 }),
    );
  });

  it("logs error status codes (4xx) with errorCode", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 401,
      errorCode: "UNAUTHORIZED",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ status: 401, errorCode: "UNAUTHORIZED" }),
    );
  });

  it("logs server error (5xx) with errorCode", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue(undefined);

    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({ status: 500, errorCode: "INTERNAL_ERROR" }),
    );
  });

  it("logs rate-limit response (429) with actorId and errorCode", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue({
      request_id: "req-429",
      correlation_id: "corr-429",
    });

    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 429,
      actorId: "GWALL1",
      errorCode: "RATE_LIMITED",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "http access",
      expect.objectContaining({
        status: 429,
        actorId: "GWALL1",
        errorCode: "RATE_LIMITED",
        request_id: "req-429",
        correlation_id: "corr-429",
      }),
    );
  });

  it("does not include traceparent field when correlation context has none", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue({
      request_id: "req-no-trace",
      correlation_id: "corr-no-trace",
      // no traceparent
    });

    logAccessEvent({ method: "GET", path: "/api/exports", status: 200 });

    const [, payload] = (logger.info as jest.Mock).mock.calls[0];
    expect(payload).not.toHaveProperty("traceparent");
  });

  it("logs all fields together for a successful POST /api/exports", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue({
      request_id: "req-full",
      correlation_id: "corr-full",
      traceparent: "00-abc-def-01",
    });

    const jobId = "job-abc-123";
    logAccessEvent({
      method: "POST",
      path: "/api/exports",
      status: 201,
      durationMs: 88,
      actorId: "GSENDERXYZ",
      exportJobId: jobId,
    });

    expect(logger.info).toHaveBeenCalledWith("http access", {
      method: "POST",
      path: "/api/exports",
      status: 201,
      durationMs: 88,
      actorId: "GSENDERXYZ",
      exportJobId: jobId,
      request_id: "req-full",
      correlation_id: "corr-full",
      traceparent: "00-abc-def-01",
    });
  });

  it("logs all fields together for a successful GET /api/exports", () => {
    (getCorrelationContext as jest.Mock).mockReturnValue({
      request_id: "req-get",
      correlation_id: "corr-get",
    });

    logAccessEvent({
      method: "GET",
      path: "/api/exports",
      status: 200,
      durationMs: 15,
      actorId: "GSENDERXYZ",
    });

    expect(logger.info).toHaveBeenCalledWith("http access", {
      method: "GET",
      path: "/api/exports",
      status: 200,
      durationMs: 15,
      actorId: "GSENDERXYZ",
      request_id: "req-get",
      correlation_id: "corr-get",
    });
  });
});
