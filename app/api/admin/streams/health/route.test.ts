/** @jest-environment node */
import { GET } from "./route";
import { _resetAdminStateForTesting } from "@/app/lib/admin-guard";
import { resetDb, getStore } from "@/app/lib/db";
import type { Stream } from "@/app/types/openapi";

const ADMIN_ADDRESS = "GADMIN_TEST_ADDRESS_56789";

function makeAdminRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/streams/health", {
    method: "GET",
    headers: {
      "Actor-Wallet-Address": ADMIN_ADDRESS,
      "x-correlation-id": "test-correlation-id-999",
      ...headers,
    },
  });
}

function makeUnauthorizedRequest(): Request {
  return new Request("http://localhost/api/admin/streams/health", {
    method: "GET",
    headers: {
      "Actor-Wallet-Address": "GNOT_ADMIN_ADDRESS",
    },
  });
}

function setupMockStreams(mockStreams: Record<string, Stream>) {
  resetDb({});
  const store = getStore();
  store.streamRepository.streams.clear();
  for (const [id, stream] of Object.entries(mockStreams)) {
    store.streamRepository.streams.set(id, stream);
  }
}

describe("GET /api/admin/streams/health", () => {
  beforeEach(() => {
    _resetAdminStateForTesting(ADMIN_ADDRESS);
    resetDb({});
    getStore().streamRepository.streams.clear();
  });

  it("returns 403 Forbidden with standard error envelope when request is unauthorized", async () => {
    const request = makeUnauthorizedRequest();
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Admin authorization required");
    expect(body.error.request_id).toBeDefined();
  });

  it("returns 200 OK with correct aggregated metrics for an empty database", async () => {
    const request = makeAdminRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.health.total).toBe(0);
    expect(body.data.health.failureRatePct).toBe(0);
    expect(body.data.health.oldestStuckAt).toBeNull();
    expect(body.data.health.byStatus).toEqual({});
    expect(body.data.health.checkedAt).toBeDefined();
  });

  it("correctly computes active, paused, errored, and stuck stream states", async () => {
    const mockStreams: Record<string, Stream> = {
      "stream-1": {
        id: "stream-1",
        status: "active",
        createdAt: "2026-07-26T10:00:00Z",
      } as any,
      "stream-2": {
        id: "stream-2",
        status: "paused",
        createdAt: "2026-07-26T11:00:00Z",
      } as any,
      "stream-3": {
        id: "stream-3",
        status: "errored",
        createdAt: "2026-07-26T09:00:00Z", // errored
      } as any,
      "stream-4": {
        id: "stream-4",
        status: "stuck",
        createdAt: "2026-07-26T08:00:00Z", // older stuck
      } as any,
      "stream-5": {
        id: "stream-5",
        status: "active",
        createdAt: "2026-07-26T12:00:00Z",
      } as any,
    };

    setupMockStreams(mockStreams);

    const request = makeAdminRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    const health = body.data.health;
    expect(health.total).toBe(5);
    expect(health.byStatus).toEqual({
      active: 2,
      paused: 1,
      errored: 1,
      stuck: 1,
    });
    // errored/total = 1/5 = 20%
    expect(health.failureRatePct).toBe(20);
    // Oldest among errored or stuck (stream-3: 09:00, stream-4: 08:00) is stream-4 (08:00)
    expect(health.oldestStuckAt).toBe("2026-07-26T08:00:00Z");
  });

  it("handles default statuses correctly when status or createdAt is missing", async () => {
    const mockStreams: Record<string, Stream> = {
      "stream-1": {
        id: "stream-1",
        // status is undefined
      } as any,
    };

    setupMockStreams(mockStreams);

    const request = makeAdminRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.health.total).toBe(1);
    expect(body.data.health.byStatus).toEqual({ unknown: 1 });
  });

  it("returns 500 Internal Server Error when repository access throws an exception", async () => {
    const store = getStore();
    jest.spyOn(store.streamRepository.streams, "values").mockImplementationOnce(() => {
      throw new Error("Simulated db crash");
    });

    const request = makeAdminRequest();
    const response = await GET(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.error.message).toContain("An unexpected error occurred");
    expect(body.error.request_id).toBeDefined();
  });
});
