/** @jest-environment node */

import { POST } from "@/app/api/admin/quotas/route";
import { PUT } from "@/app/api/admin/quotas/[id]/route";
import { _resetQuotasForTesting, upsertQuota } from "@/app/lib/quotas";

const ADMIN = "GADMIN_DEV_PLACEHOLDER_DO_NOT_USE_IN_PROD";

function request(path: string, method: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Actor-Wallet-Address": ADMIN,
      "Content-Type": "application/json",
    },
    body: '{"scope":"user","subject":"GUSER","maxMonthlyVolumeStroops":1e309}',
  });
}

beforeEach(() => {
  _resetQuotasForTesting();
});

it.each([
  ["POST /api/admin/quotas", "/api/admin/quotas", "POST"],
  ["PUT /api/admin/quotas/:id", "/api/admin/quotas/quota-test", "PUT"],
] as const)("%s rejects non-finite quota values", async (_label, path, method) => {
  if (method === "PUT") {
    upsertQuota({ scope: "user", subject: "GUSER" });
  }

  const context = { params: Promise.resolve({ id: "quota-test" }) };
  const response =
    method === "PUT"
      ? await PUT(request(path, method), context)
      : await POST(request(path, method));

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: "VALIDATION_ERROR" },
  });
});
