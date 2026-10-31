import { NextResponse } from "next/server";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";

export async function checkStreamPreviewRateLimit(
  request: Request,
): Promise<NextResponse | null> {
  const path = new URL(request.url).pathname;
  const limitType = getLimitForRoute("POST", "/api/streams/preview");
  const identity = getClientIdentity(request);
  const result = await checkRateLimit(identity, limitType);

  if (!result.allowed) {
    recordThrottle(path, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(result.retryAfter!);
  }

  recordRequest(path);
  return null;
}
