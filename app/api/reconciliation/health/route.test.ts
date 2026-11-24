/** @jest-environment node */

import { GET } from "./route";

function createRequest() {
  return new Request("http://localhost/api/reconciliation/health");
}

describe("GET /api/reconciliation/health", () => {
  const originalDbReady = process.env.RECONCILIATION_DB_READY;
  const originalRpcReady = process.env.RECONCILIATION_RPC_READY;

  afterEach(() => {
    if (originalDbReady === undefined) {
      delete process.env.RECONCILIATION_DB_READY;
    } else {
      process.env.RECONCILIATION_DB_READY = originalDbReady;
    }

    if (originalRpcReady === undefined) {
      delete process.env.RECONCILIATION_RPC_READY;
    } else {
      process.env.RECONCILIATION_RPC_READY = originalRpcReady;
    }
  });

  it("returns 200 ok when both dependencies are ready", async () => {
    process.env.RECONCILIATION_DB_READY = "true";
    process.env.RECONCILIATION_RPC_READY = "true";

    const res = await GET(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.onchain.status).toBe("ok");
  });

  it("returns 503 degraded when either dependency is not ready", async () => {
    process.env.RECONCILIATION_DB_READY = "false";
    process.env.RECONCILIATION_RPC_READY = "true";

    const res = await GET(createRequest());
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("degraded");
    expect(body.checks.onchain.status).toBe("ok");
  });

  it("returns 503 degraded when both dependencies are unavailable", async () => {
    process.env.RECONCILIATION_DB_READY = "false";
    process.env.RECONCILIATION_RPC_READY = "false";

    const res = await GET(createRequest());
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("degraded");
    expect(body.checks.onchain.status).toBe("degraded");
  });
});
