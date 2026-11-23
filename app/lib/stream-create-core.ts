import { NextResponse } from "next/server";
import { errorResponse } from "@/app/lib/errors/server";
import { withLock } from "@/app/lib/db";
import type { ClientIdentity } from "@/app/lib/rate-limit";
import type { CreationQuotaResult } from "@/app/lib/quota-enforcement";

export const STREAM_CREATION_QUOTA_LOCK_ID = "stream-creation-quota";

export function withStreamCreationQuotaLock<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return withLock(STREAM_CREATION_QUOTA_LOCK_ID, callback);
}

export function quotaUserId(identity: ClientIdentity): string | undefined {
  return identity.type === "wallet" ? identity.value : undefined;
}

/** Convert a validated decimal XLM rate to raw stroops without floating point. */
export function rateToStroops(rate: string, token: string): bigint {
  if (token !== "XLM") return 0n;

  const match = /^(\d+)(?:\.(\d+))?(?:\s+.*)?$/.exec(rate.trim());
  if (!match || (match[2]?.length ?? 0) > 7) {
    throw new RangeError("Validated XLM rate could not be converted to stroops.");
  }

  return (
    BigInt(match[1]) * 10_000_000n +
    BigInt((match[2] ?? "").padEnd(7, "0") || "0")
  );
}

export function creationQuotaResponse(
  result: Extract<CreationQuotaResult, { allowed: false }>,
): NextResponse {
  const response = errorResponse(result.code, result.reason, 429);
  if (result.retryAfter !== undefined) {
    response.headers.set("Retry-After", String(result.retryAfter));
  }
  return response;
}
