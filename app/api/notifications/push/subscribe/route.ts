import { NextResponse } from "next/server";
import { z } from "zod";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { getCorrelationContext } from "@/app/lib/logger";
import {
  getPushSubscriptionStore,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  type PushSubscriptionData,
} from "@/app/lib/push-store";
import { getPushConfig } from "@/app/lib/push-config";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { withRouteSpan } from "@/lib/routeSpan";

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine((value) => {
    try {
      const endpoint = new URL(value);
      return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password;
    } catch {
      return false;
    }
  }, "Endpoint must be an HTTPS URL."),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
    auth: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/),
  }).strict(),
}).strict();

const deleteSchema = z.object({
  endpoint: z.string().url().max(2048).refine((value) => {
    try {
      const endpoint = new URL(value);
      return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password;
    } catch {
      return false;
    }
  }, "Endpoint must be an HTTPS URL."),
}).strict();

function errorResponse(
  request: Request,
  code: string,
  message: string,
  status: number,
  details?: unknown,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        request_id: getCorrelationContext()?.request_id,
      },
    },
    { status },
  );
}

async function checkRequestLimit(request: Request, method: "GET" | "POST" | "DELETE") {
  const url = new URL(request.url);
  const identity = getClientIdentity(request);
  const limitType = getLimitForRoute(method, url.pathname);
  const result = await checkRateLimit(identity, limitType);

  if (!result.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(result.retryAfter ?? 60);
  }
  recordRequest(url.pathname);
  return null;
}

function unavailableResponse(request: Request) {
  return errorResponse(
    request,
    "PUSH_DISABLED",
    "Web Push is not configured.",
    503,
  );
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleGet(request: Request) {
  const config = getPushConfig();
  if (!config) return unavailableResponse(request);

  const limited = await checkRequestLimit(request, "GET");
  if (limited) return limited;

  return NextResponse.json(
    { data: { publicKey: config.publicKey } },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

async function handlePost(request: Request) {
  if (!getPushConfig()) return unavailableResponse(request);

  const limited = await checkRequestLimit(request, "POST");
  if (limited) return limited;

  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Authentication is required.", 401);
  }

  const parsed = subscriptionSchema.safeParse(await parseJson(request));
  if (!parsed.success) {
    return errorResponse(
      request,
      "VALIDATION_ERROR",
      "A valid HTTPS push subscription is required.",
      400,
      parsed.error.issues.map(({ path, message }) => ({ path, message })),
    );
  }

  const subscription: PushSubscriptionData = {
    endpoint: parsed.data.endpoint,
    keys: parsed.data.keys,
  };
  const result = getPushSubscriptionStore().add(
    actor.actorId,
    subscription,
    MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  );

  if (result === "limit") {
    return errorResponse(
      request,
      "SUBSCRIPTION_LIMIT_REACHED",
      `A user may register at most ${MAX_PUSH_SUBSCRIPTIONS_PER_USER} push subscriptions.`,
      409,
    );
  }
  if (result === "conflict") {
    return errorResponse(
      request,
      "SUBSCRIPTION_ALREADY_REGISTERED",
      "This push endpoint is already registered to another user.",
      409,
    );
  }

  return NextResponse.json({ data: { subscribed: true } });
}

async function handleDelete(request: Request) {
  if (!getPushConfig()) return unavailableResponse(request);

  const limited = await checkRequestLimit(request, "DELETE");
  if (limited) return limited;

  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Authentication is required.", 401);
  }

  const parsed = deleteSchema.safeParse(await parseJson(request));
  if (!parsed.success) {
    return errorResponse(
      request,
      "VALIDATION_ERROR",
      "A valid HTTPS subscription endpoint is required.",
      400,
      parsed.error.issues.map(({ path, message }) => ({ path, message })),
    );
  }

  const removed = getPushSubscriptionStore().remove(actor.actorId, parsed.data.endpoint);
  return NextResponse.json({ data: { removed } });
}

const route = (method: "GET" | "POST" | "DELETE", handler: (request: Request) => Promise<Response>) =>
  (request: Request) =>
    withRouteSpan(`/api/notifications/push/subscribe:${method}`, () =>
      handler(request),
    )(request);

export const GET = route("GET", handleGet);
export const POST = route("POST", handlePost);
export const DELETE = route("DELETE", handleDelete);
