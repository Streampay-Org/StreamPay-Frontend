/**
 * GET  /api/notifications/preferences  - Get notification preferences for authenticated user
 * PUT  /api/notifications/preferences  - Update notification preferences
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import {
  QuietHoursConfig,
  DEFAULT_QUIET_HOURS,
  validatePartialQuietHours,
} from "@/app/lib/quiet-hours";

export interface NotificationPreferences {
  userId: string;
  email: boolean;
  inApp: boolean;
  webhook: boolean;
  events: {
    streamCreated: boolean;
    streamCompleted: boolean;
    streamCancelled: boolean;
    paymentFailed: boolean;
    lowBalance: boolean;
  };
  quietHours: QuietHoursConfig;
  updatedAt: string;
}

const prefsStore = new Map<string, NotificationPreferences>();

const DEFAULT_PREFS: Omit<NotificationPreferences, "userId" | "updatedAt"> = {
  email: true,
  inApp: true,
  webhook: false,
  events: {
    streamCreated: true,
    streamCompleted: true,
    paymentFailed: true,
    streamCancelled: true,
    lowBalance: false,
  },
  quietHours: {
    ...DEFAULT_QUIET_HOURS,
  },
};

const TOP_LEVEL_FIELDS = ["email", "inApp", "webhook", "events", "quietHours"] as const;
const EVENT_FIELDS = [
  "streamCreated",
  "streamCompleted",
  "streamCancelled",
  "paymentFailed",
  "lowBalance",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function getRequestId(request: Request): string {
  return (
    request.headers.get("x-request-id") ??
    request.headers.get("request-id") ??
    getCorrelationContext()?.request_id ??
    randomUUID()
  );
}

function createErrorResponse(request: Request, code: string, message: string, status: number) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: getRequestId(request),
      },
    },
    { status },
  );
}

function getPreferences(userId: string): NotificationPreferences {
  const existing = prefsStore.get(userId);
  if (existing) {
    // Ensure quietHours is populated even if previously saved without it
    return {
      ...existing,
      quietHours: existing.quietHours ?? { ...DEFAULT_QUIET_HOURS },
    };
  }
  return {
    userId,
    ...DEFAULT_PREFS,
    updatedAt: new Date().toISOString(),
  };
}

interface PartialPreferencePayload {
  email?: boolean;
  inApp?: boolean;
  webhook?: boolean;
  events?: Partial<NotificationPreferences["events"]>;
  quietHours?: Partial<QuietHoursConfig>;
}

function validatePreferencePayload(body: unknown): PartialPreferencePayload | null {
  if (!isRecord(body)) {
    return null;
  }

  const extraKeys = Object.keys(body).filter((key) => !TOP_LEVEL_FIELDS.includes(key as (typeof TOP_LEVEL_FIELDS)[number]));
  if (extraKeys.length > 0) {
    return null;
  }

  const normalized: PartialPreferencePayload = {};

  if ("email" in body && !isBoolean(body.email)) return null;
  if ("inApp" in body && !isBoolean(body.inApp)) return null;
  if ("webhook" in body && !isBoolean(body.webhook)) return null;

  if ("email" in body) normalized.email = body.email as boolean;
  if ("inApp" in body) normalized.inApp = body.inApp as boolean;
  if ("webhook" in body) normalized.webhook = body.webhook as boolean;

  if ("events" in body) {
    if (!isRecord(body.events)) return null;

    const eventKeys = Object.keys(body.events);
    const invalidEventKeys = eventKeys.filter((key) => !EVENT_FIELDS.includes(key as (typeof EVENT_FIELDS)[number]));
    if (invalidEventKeys.length > 0) return null;

    const eventPayload: Partial<NotificationPreferences["events"]> = {};
    for (const eventKey of EVENT_FIELDS) {
      if (eventKey in body.events && !isBoolean(body.events[eventKey])) {
        return null;
      }
      if (eventKey in body.events) {
        eventPayload[eventKey] = body.events[eventKey] as boolean;
      }
    }

    normalized.events = eventPayload;
  }

  if ("quietHours" in body) {
    if (!isRecord(body.quietHours)) return null;
    const quietResult = validatePartialQuietHours(body.quietHours);
    if (!quietResult.valid) {
      return null;
    }
    normalized.quietHours = quietResult.value;
  }

  return normalized;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const rateLimitResult = await checkRateLimit(identity, limitType);

  if (!rateLimitResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }
  recordRequest(url.pathname);

  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    logger.warn("Notification preferences request rejected: missing or invalid auth", {
      method: request.method,
      path: url.pathname,
    });
    return createErrorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const preferences = getPreferences(actor.actorId);
  const etag = computeETag(actor.actorId, preferences);

  logger.info("Notification preferences fetched", {
    actorId: actor.actorId,
    walletAddress: actor.walletAddress,
  });

  return NextResponse.json({ preferences }, {
    headers: {
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}

export async function PUT(request: Request) {
  const url = new URL(request.url);
  const limitType = getLimitForRoute("PUT", url.pathname);
  const identity = getClientIdentity(request);
  const rateLimitResult = await checkRateLimit(identity, limitType);

  if (!rateLimitResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }
  recordRequest(url.pathname);

  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    logger.warn("Notification preferences update rejected: missing or invalid auth", {
      method: request.method,
      path: url.pathname,
    });
    return createErrorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse(request, "INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const payload = validatePreferencePayload(body);
  if (!payload) {
    return createErrorResponse(
      request,
      "INVALID_BODY",
      "Request body must be a JSON object with valid preference fields (email, inApp, webhook, events, quietHours)",
      400,
    );
  }

  const existing = getPreferences(actor.actorId);
  const currentEtag = computeETag(actor.actorId, existing);
  const ifMatch = request.headers.get("if-match");

  if (ifMatch && !ifNoneMatchMatches(ifMatch, currentEtag)) {
    logger.warn("Notification preferences update conflict detected", {
      actorId: actor.actorId,
      ifMatch,
      currentEtag,
    });
    return createErrorResponse(
      request,
      "STATE_CONFLICT",
      "Notification preferences have been modified concurrently. Please reload and retry.",
      409,
    );
  }

  const updated: NotificationPreferences = {
    ...existing,
    ...payload,
    events: {
      ...existing.events,
      ...(payload.events ?? {}),
    },
    quietHours: {
      ...(existing.quietHours ?? DEFAULT_QUIET_HOURS),
      ...(payload.quietHours ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };

  prefsStore.set(actor.actorId, updated);
  const newEtag = computeETag(actor.actorId, updated);

  logger.info("Notification preferences updated", {
    actorId: actor.actorId,
    updatedFields: Object.keys(payload),
  });

  return NextResponse.json({ preferences: updated }, {
    headers: {
      ETag: newEtag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
