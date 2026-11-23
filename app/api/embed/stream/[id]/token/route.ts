import { NextResponse } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { getStore } from "@/app/lib/db";
import { createEmbedToken } from "@/lib/embed-token";
import {
  checkRateLimit,
  rateLimitResponse,
  type ClientIdentity,
} from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function jsonResponse(
  body: unknown,
  status: number,
  headers?: HeadersInit,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

export async function POST(request: Request, context: RouteContext) {
  const actor = tryAuthenticateRequest(request);

  if (!actor) {
    return jsonResponse(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const { id } = await context.params;

  if (!id || id.length > 256) {
    return jsonResponse(
      { error: { code: "NOT_FOUND", message: "Stream not found" } },
      404,
    );
  }

  const url = new URL(request.url);
  const limitType = getLimitForRoute("POST", url.pathname);

  const identity: ClientIdentity = {
    type: "wallet",
    value: actor.walletAddress,
    displayValue: `${actor.walletAddress.slice(0, 16)}...`,
  };

  const rateCheck = await checkRateLimit(identity, limitType);

  if (!rateCheck.allowed) {
    recordThrottle(
      url.pathname,
      limitType,
      identity.type,
      identity.displayValue,
    );

    const response = rateLimitResponse(rateCheck.retryAfter!);
    response.headers.set("Cache-Control", "no-store, private");
    return response;
  }

  recordRequest(url.pathname);

  const stream = await getStore().streamRepository.streams.get(id);

  // Match the ownership convention used by the exports implementation.
  const ownerId = (stream as { ownerId?: string } | undefined)?.ownerId;

  // Missing and unauthorized streams intentionally have identical responses.
  if (!stream || ownerId !== actor.walletAddress) {
    return jsonResponse(
      { error: { code: "NOT_FOUND", message: "Stream not found" } },
      404,
    );
  }

  try {
    const token = createEmbedToken(id);

    return jsonResponse({
      data: {
        token,
        expiresIn: 15 * 60,
        embedUrl: `/embed/stream/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`,
      },
    }, 200);
  } catch {
    return jsonResponse(
      { error: { code: "INTERNAL_ERROR", message: "Unable to create embed token" } },
      500,
    );
  }
}
