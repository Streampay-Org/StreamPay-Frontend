/** @jest-environment node */
import { POST, GET } from "./route";
import { _resetAdminStateForTesting } from "@/app/lib/admin-guard";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";

const ADMIN_ADDRESS = "GADMIN_TEST_ADDRESS_12345";
const VALID_REASON = "Emergency maintenance due to upstream incident";

function makeRequest(
  method: "POST" | "GET",
  body?: Record<string, unknown>,
  actor: string | null = ADMIN_ADDRESS,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (actor) {
    headers["Actor-Wallet-Address"] = actor;
  }
  return new Request("http://localhost/api/admin/pause", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  _resetAdminStateForTesting(ADMIN_ADDRESS);
  resetAuditLogStore();
});

describe("POST /api/admin/pause", () => {
  it("activates global pause with valid reason and records audit metadata", async () => {
    const res = await POST(
      makeRequest("POST", { paused: true, reason: VALID_REASON }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paused).toBe(true);
    expect(body.auditRequestId).toBeTruthy();

    const entries = auditLogStore.list({ action: "admin.pause.activate" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].metadata?.reason).toBe(VALID_REASON);
  });

  it("is idempotent when pause is already active", async () => {
    await POST(makeRequest("POST", { paused: true, reason: VALID_REASON }));
    const res = await POST(
      makeRequest("POST", { paused: true, reason: VALID_REASON }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paused).toBe(true);
  });

  it("lifts global pause with valid reason", async () => {
    await POST(makeRequest("POST", { paused: true, reason: VALID_REASON }));
    const res = await POST(
      makeRequest("POST", { paused: false, reason: "Incident resolved and verified" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paused).toBe(false);
    expect(body.auditRequestId).toBeTruthy();
  });

  it("returns 422 when reason is missing", async () => {
    const res = await POST(makeRequest("POST", { paused: true }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when reason is too short", async () => {
    const res = await POST(
      makeRequest("POST", { paused: true, reason: "short" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 403 when caller is not admin", async () => {
    const res = await POST(
      makeRequest("POST", { paused: true, reason: VALID_REASON }, null),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("Unauthorized");
  });
});

describe("GET /api/admin/pause", () => {
  it("returns current pause state", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.paused).toBe(false);
  });
});
