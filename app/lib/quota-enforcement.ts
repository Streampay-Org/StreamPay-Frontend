import { getStore } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import { listQuotas, type Quota, type QuotaScope } from "@/app/lib/quotas";
import type { Stream } from "@/app/types/openapi";

const ACTIVE_STATUSES = new Set(["active", "paused", "draft"]);
const STROOPS_PER_XLM = 10_000_000n;

export type CreationQuotaCode =
  | "QUOTA_ACTIVE_STREAMS_EXCEEDED"
  | "QUOTA_MONTHLY_VOLUME_EXCEEDED";

export type CreationQuotaResult =
  | { allowed: true }
  | {
      allowed: false;
      code: CreationQuotaCode;
      reason: string;
      limit: number | bigint;
      used: number | bigint;
      retryAfter?: number;
      scope: QuotaScope;
      subject: string;
    };

export interface CreationQuotaInput {
  userId?: string;
  orgId?: string;
  amountStroops: bigint;
  now?: Date;
}

function quotaFor(scope: QuotaScope, subject: string): Quota | undefined {
  return listQuotas().find(
    (quota) => quota.scope === scope && quota.subject === subject,
  );
}

function belongsToQuota(stream: Stream, scope: QuotaScope, subject: string): boolean {
  if (scope === "user") {
    return stream.senderAddress === subject;
  }
  return orgDb.streamOwnership.get(stream.id) === subject;
}

function amountStroopsFor(stream: Stream): bigint | null {
  if (stream.totalAmount !== undefined) {
    if (/^\d+$/.test(stream.totalAmount)) {
      return BigInt(stream.totalAmount);
    }
    return null;
  }

  const rate = /^(\d+)(?:\.(\d+))?/.exec(stream.rate.trim());
  if (!rate || (rate[2]?.length ?? 0) > 7) {
    return null;
  }

  return (
    BigInt(rate[1]) * STROOPS_PER_XLM +
    BigInt((rate[2] ?? "").padEnd(7, "0") || "0")
  );
}

function monthStartUtc(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonthRetryAfter(date: Date): number {
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((nextMonth - date.getTime()) / 1000));
}

function activeStreamCount(streams: Stream[], scope: QuotaScope, subject: string): number {
  return streams.filter(
    (stream) =>
      belongsToQuota(stream, scope, subject) && ACTIVE_STATUSES.has(stream.status),
  ).length;
}

function monthlyVolume(
  streams: Stream[],
  scope: QuotaScope,
  subject: string,
  now: Date,
): bigint {
  const start = monthStartUtc(now);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return streams.reduce((total, stream) => {
    const createdAt = Date.parse(stream.createdAt);
    if (
      !belongsToQuota(stream, scope, subject) ||
      stream.token !== "XLM" ||
      !Number.isFinite(createdAt) ||
      createdAt < start ||
      createdAt >= end
    ) {
      return total;
    }
    return total + (amountStroopsFor(stream) ?? 0n);
  }, 0n);
}

function asStroopsLimit(limit: number): bigint {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new RangeError("Configured monthly quota must be a finite non-negative number.");
  }
  return BigInt(Math.floor(limit));
}

/**
 * Check configured org and user limits for one stream creation.
 * Active means draft, active, or paused; ended, withdrawn, and cancelled
 * streams do not count. Monthly volume is the sum of XLM stream amounts
 * created in the current UTC month.
 */
export function checkCreationQuota({
  userId,
  orgId,
  amountStroops,
  now = new Date(),
}: CreationQuotaInput): CreationQuotaResult {
  if (amountStroops < 0n) {
    throw new RangeError("Stream amount must be non-negative.");
  }

  const streams = Array.from(getStore().streamRepository.streams.values());
  const quotas: Array<{ scope: QuotaScope; subject: string; quota: Quota }> = [];
  if (orgId) {
    const quota = quotaFor("org", orgId);
    if (quota) quotas.push({ scope: "org", subject: orgId, quota });
  }
  if (userId) {
    const quota = quotaFor("user", userId);
    if (quota) quotas.push({ scope: "user", subject: userId, quota });
  }

  for (const { scope, subject, quota } of quotas) {
    if (quota.maxActiveStreams > 0) {
      const used = activeStreamCount(streams, scope, subject);
      if (used + 1 > quota.maxActiveStreams) {
        return {
          allowed: false,
          code: "QUOTA_ACTIVE_STREAMS_EXCEEDED",
          reason: `The ${scope} has ${used} active streams; the configured limit is ${quota.maxActiveStreams}.`,
          limit: quota.maxActiveStreams,
          used,
          scope,
          subject,
        };
      }
    }

    if (quota.maxMonthlyVolumeStroops > 0) {
      const limit = asStroopsLimit(quota.maxMonthlyVolumeStroops);
      const used = monthlyVolume(streams, scope, subject, now);
      if (used + amountStroops > limit) {
        return {
          allowed: false,
          code: "QUOTA_MONTHLY_VOLUME_EXCEEDED",
          reason: `The ${scope} has used ${used.toString()} of ${limit.toString()} monthly XLM stroops.`,
          limit,
          used,
          retryAfter: nextMonthRetryAfter(now),
          scope,
          subject,
        };
      }
    }
  }

  return { allowed: true };
}
