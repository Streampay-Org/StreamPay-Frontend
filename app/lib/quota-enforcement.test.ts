/** @jest-environment node */

import { getStore, resetDb } from "@/app/lib/db";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import {
  _resetQuotasForTesting,
  deleteQuota,
  upsertQuota,
} from "@/app/lib/quotas";
import { checkCreationQuota } from "@/app/lib/quota-enforcement";
import type { Stream } from "@/app/types/openapi";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const USER = "GUSER";
const ORG = "org-quota-test";

function stream(
  id: string,
  options: Partial<Stream> = {},
): Stream {
  return {
    id,
    recipient: "recipient",
    rate: "1",
    schedule: "month",
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    token: "XLM",
    ...options,
  };
}

function addStream(value: Stream, orgId?: string): void {
  getStore().streamRepository.streams.set(value.id, value);
  if (orgId) orgDb.streamOwnership.set(value.id, orgId);
}

beforeEach(() => {
  resetDb();
  _resetQuotasForTesting();
  _resetOrgDbForTesting();
});

describe("checkCreationQuota", () => {
  it("allows missing and zero-valued quotas", () => {
    expect(
      checkCreationQuota({ userId: USER, amountStroops: 1n, now: NOW }),
    ).toEqual({ allowed: true });

    upsertQuota({
      scope: "user",
      subject: USER,
      maxActiveStreams: 0,
      maxMonthlyVolumeStroops: 0,
    });
    expect(
      checkCreationQuota({ userId: USER, amountStroops: 1n, now: NOW }),
    ).toEqual({ allowed: true });
  });

  it("counts draft, active, and paused streams but excludes terminal streams", () => {
    upsertQuota({ scope: "user", subject: USER, maxActiveStreams: 3 });
    addStream(stream("active", { senderAddress: USER, status: "active" }));
    addStream(stream("draft", { senderAddress: USER, status: "draft" }));
    addStream(stream("paused", { senderAddress: USER, status: "paused" }));
    addStream(stream("ended", { senderAddress: USER, status: "ended" }));
    addStream(stream("withdrawn", { senderAddress: USER, status: "withdrawn" }));
    addStream(stream("cancelled", { senderAddress: USER, status: "cancelled" }));

    expect(
      checkCreationQuota({ userId: USER, amountStroops: 1n, now: NOW }),
    ).toMatchObject({
      allowed: false,
      code: "QUOTA_ACTIVE_STREAMS_EXCEEDED",
      limit: 3,
      used: 3,
      scope: "user",
    });
  });

  it("enforces the stricter user quota when org and user limits both exist", () => {
    upsertQuota({ scope: "org", subject: ORG, maxActiveStreams: 10 });
    upsertQuota({ scope: "user", subject: USER, maxActiveStreams: 1 });
    addStream(stream("owned", { senderAddress: USER }), ORG);

    expect(
      checkCreationQuota({
        userId: USER,
        orgId: ORG,
        amountStroops: 1n,
        now: NOW,
      }),
    ).toMatchObject({
      allowed: false,
      code: "QUOTA_ACTIVE_STREAMS_EXCEEDED",
      scope: "user",
      subject: USER,
      used: 1,
    });
  });

  it("reports the org quota when it is stricter than the user quota", () => {
    upsertQuota({ scope: "org", subject: ORG, maxActiveStreams: 1 });
    upsertQuota({ scope: "user", subject: USER, maxActiveStreams: 10 });
    addStream(stream("org-owned"), ORG);

    expect(
      checkCreationQuota({
        userId: USER,
        orgId: ORG,
        amountStroops: 1n,
        now: NOW,
      }),
    ).toMatchObject({
      allowed: false,
      code: "QUOTA_ACTIVE_STREAMS_EXCEEDED",
      scope: "org",
      subject: ORG,
      used: 1,
    });
  });

  it("uses bigint arithmetic for existing volumes above Number.MAX_SAFE_INTEGER", () => {
    const alreadyUsed = 9_007_199_254_740_993n;
    const newAmount = 3n;
    upsertQuota({
      scope: "user",
      subject: USER,
      maxMonthlyVolumeStroops: Number.MAX_SAFE_INTEGER,
    });
    addStream(
      stream("large-volume", {
        senderAddress: USER,
        totalAmount: alreadyUsed.toString(),
      }),
    );

    expect(
      checkCreationQuota({
        userId: USER,
        amountStroops: newAmount,
        now: NOW,
      }),
    ).toMatchObject({
      allowed: false,
      code: "QUOTA_MONTHLY_VOLUME_EXCEEDED",
      used: alreadyUsed,
      limit: BigInt(Number.MAX_SAFE_INTEGER),
    });
  });

  it("permits monthly volume that lands exactly on the limit", () => {
    upsertQuota({
      scope: "user",
      subject: USER,
      maxMonthlyVolumeStroops: 100,
    });
    addStream(stream("at-limit", { senderAddress: USER, totalAmount: "97" }));

    expect(
      checkCreationQuota({ userId: USER, amountStroops: 3n, now: NOW }),
    ).toEqual({ allowed: true });
  });

  it("rejects a volume overage and reports seconds until the next UTC month", () => {
    upsertQuota({
      scope: "user",
      subject: USER,
      maxMonthlyVolumeStroops: 100,
    });
    addStream(
      stream("used", {
        senderAddress: USER,
        totalAmount: "100",
      }),
    );
    const now = new Date("2026-06-30T23:59:59.000Z");

    expect(
      checkCreationQuota({ userId: USER, amountStroops: 1n, now }),
    ).toMatchObject({
      allowed: false,
      code: "QUOTA_MONTHLY_VOLUME_EXCEEDED",
      limit: 100n,
      used: 100n,
      retryAfter: 1,
    });
  });

  it("resets monthly usage at the UTC month boundary", () => {
    upsertQuota({
      scope: "user",
      subject: USER,
      maxMonthlyVolumeStroops: 100,
    });
    addStream(
      stream("prior-month", {
        senderAddress: USER,
        totalAmount: "100",
        createdAt: "2026-05-31T23:59:59.000Z",
      }),
    );

    expect(
      checkCreationQuota({
        userId: USER,
        amountStroops: 100n,
        now: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).toEqual({ allowed: true });
  });

  it("ignores deleted quota records", () => {
    const quota = upsertQuota({
      scope: "org",
      subject: ORG,
      maxActiveStreams: 1,
    });
    addStream(stream("org-active"), ORG);
    deleteQuota(quota.id);

    expect(
      checkCreationQuota({ orgId: ORG, amountStroops: 1n, now: NOW }),
    ).toEqual({ allowed: true });
  });
});
