import { GET } from "./route";
import { getStore } from "@/app/lib/db";
import { logger } from "@/app/lib/logger";

jest.mock("@/app/lib/db", () => ({
  getStore: jest.fn(),
}));

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn().mockReturnValue({ request_id: "test-req-id" }),
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe("/api/streams/health GET", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 OK when dependencies are healthy", async () => {
    (getStore as jest.Mock).mockReturnValue({
      kind: "memory",
      streamRepository: {}, // Mock defined streamRepository
    });

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checked_at).toBeDefined();
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.database.kind).toBe("memory");

    expect(logger.info).toHaveBeenCalledWith("Streams health probe successful", { kind: "memory" });
  });

  it("returns 503 SERVICE_UNAVAILABLE when dependencies are degraded (streamRepository is null)", async () => {
    (getStore as jest.Mock).mockReturnValue({
      kind: "memory",
      streamRepository: null, // simulates a failure/uninitialized state
    });

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toBe("One or more dependencies are degraded.");
    expect(body.error.request_id).toBe("test-req-id");

    expect(logger.error).toHaveBeenCalledWith("Streams health probe failed", expect.any(Object));
  });

  it("returns 503 SERVICE_UNAVAILABLE when getStore throws an error", async () => {
    (getStore as jest.Mock).mockImplementation(() => {
      throw new Error("DB Connection Lost");
    });

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");

    expect(logger.error).toHaveBeenCalledWith("Streams health probe failed", { error: "DB Connection Lost" });
  });
});
