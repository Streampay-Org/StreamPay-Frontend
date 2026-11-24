/** @jest-environment node */

import { POST as createV1Stream } from "@/app/api/streams/route";
import { POST as createV2Stream } from "@/app/api/v2/streams/route";
import { resetDb } from "@/app/lib/db";
import { _resetOrgDbForTesting } from "@/app/lib/org-db";
import { getCreationQuotaMetrics, resetOrgQuotaMetrics } from "@/app/lib/org-quota-metrics";
import { _resetQuotasForTesting, upsertQuota } from "@/app/lib/quotas";

const RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function request(path: string, userId: string, rate: string): Request {
  const token = `x.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64")}.x`;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient: RECIPIENT, rate, schedule: "month" }),
  });
}

beforeEach(() => {
  resetDb();
  _resetOrgDbForTesting();
  _resetQuotasForTesting();
  resetOrgQuotaMetrics();
});

describe("stream creation quota routes", () => {
  it("serializes concurrent v1 creates so active-stream limits cannot be exceeded", async () => {
    const userId = "GQUOTA-CONCURRENT";
    upsertQuota({ scope: "user", subject: userId, maxActiveStreams: 2 });

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        createV1Stream(request("/api/streams", userId, "1")),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 429]);
    const rejected = responses.find((response) => response.status === 429);
    expect(rejected?.headers.get("Retry-After")).toBeNull();
    expect(await rejected?.json()).toMatchObject({
      error: { code: "QUOTA_ACTIVE_STREAMS_EXCEEDED" },
    });
    expect(getCreationQuotaMetrics().rejections).toEqual({
      [`user:${userId}:QUOTA_ACTIVE_STREAMS_EXCEEDED`]: 1,
    });
  });

  it("applies monthly XLM volume quotas to v2 creation with Retry-After", async () => {
    const userId = "GQUOTA-V2-VOLUME";
    upsertQuota({
      scope: "user",
      subject: userId,
      maxMonthlyVolumeStroops: 1_000_000_000,
    });

    expect((await createV2Stream(request("/api/v2/streams", userId, "50"))).status).toBe(201);
    const rejected = await createV2Stream(
      request("/api/v2/streams", userId, "60"),
    );

    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await rejected.json()).toMatchObject({
      error: { code: "QUOTA_MONTHLY_VOLUME_EXCEEDED" },
    });
  });
});
