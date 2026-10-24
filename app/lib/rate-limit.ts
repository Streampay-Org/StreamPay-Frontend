import { NextResponse } from "next/server";
import { getCorrelationContext } from "./logger";
import { RATE_LIMITS, getLimitForRoute, LimitType } from "./rate-limit-config";
import { getRateLimitStore } from "./rate-limit-store";
import { generateRequestId, REQUEST_ID_HEADER } from "@/lib/requestId";
import { resolveClientIp } from "@/lib/clientIp";
import { tryAuthenticateRequest } from "./auth";
import crypto from "crypto";

const AUTH_ACTOR_CACHE = Symbol("streampay_auth_actor_cache");

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

export interface ClientIdentity {
  type: "api_key" | "wallet" | "ip";
  value: string;
  displayValue: string;
}

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function validateApiKey(key: string): { hashPrefix: string } | null {
  const configuredKeysRaw = process.env.STREAMPAY_API_KEYS;
  if (!configuredKeysRaw) return null;

  const validHashes = configuredKeysRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (validHashes.length === 0) return null;

  const keyHash = hashString(key).toLowerCase();
  const keyHashBuffer = Buffer.from(keyHash, "utf8");

  let matchFound = false;
  for (const validHash of validHashes) {
    const validHashBuffer = Buffer.from(validHash, "utf8");
    if (
      keyHashBuffer.length === validHashBuffer.length &&
      crypto.timingSafeEqual(keyHashBuffer, validHashBuffer)
    ) {
      matchFound = true;
    }
  }

  if (matchFound) {
    return { hashPrefix: keyHash.slice(0, 4) };
  }

  return null;
}

function extractApiKey(request: Request): { value: string; displayValue: string } | null {
  const rawKey = getHeader(request, "X-API-Key");
  if (!rawKey) return null;

  const validated = validateApiKey(rawKey);
  if (!validated) return null;

  return {
    value: "api_key:" + validated.hashPrefix,
    displayValue: validated.hashPrefix,
  };
}

function extractWalletFromAuth(request: Request): string | null {
  const cached = (request as unknown as Record<symbol, unknown>)[AUTH_ACTOR_CACHE] as
    | { walletAddress?: string }
    | undefined;
  if (cached?.walletAddress) {
    return cached.walletAddress;
  }

  const actor = tryAuthenticateRequest(request);
  if (actor) {
    (request as unknown as Record<symbol, unknown>)[AUTH_ACTOR_CACHE] = actor;
    return actor.walletAddress;
  }

  return null;
}

function extractIp(request: Request): string {
  return resolveClientIp(request.headers);
}

export function getClientIdentity(request: Request): ClientIdentity {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    return {
      type: "api_key",
      value: apiKey.value,
      displayValue: apiKey.displayValue,
    };
  }

  const wallet = extractWalletFromAuth(request);
  if (wallet) {
    return {
      type: "wallet",
      value: wallet,
      displayValue: wallet.slice(0, 16) + "...",
    };
  }

  const ip = extractIp(request);
  return {
    type: "ip",
    value: ip,
    displayValue: ip,
  };
}

export async function checkRateLimit(
  identity: ClientIdentity,
  limitType: LimitType
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  const store = getRateLimitStore();
  const config = RATE_LIMITS[limitType];

  // Key per limit tier so one endpoint class cannot drain another's bucket.
  const result = await store.check(
    `${limitType}:${identity.value}`,
    config.limit,
    config.windowMs,
  );

  return {
    allowed: result.allowed,
    remaining: result.allowed ? result.remaining : 0,
    retryAfter: result.retryAfter,
  };
}

export function rateLimitResponse(retryAfter: number) {
  const requestId =
    getCorrelationContext()?.request_id ?? generateRequestId();

  return NextResponse.json(
    {
      error: {
        // keep existing shape
        request_id: requestId,
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        [REQUEST_ID_HEADER]: requestId,
      },
    },
  );
}

export async function withRateLimit(
  request: Request,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  const limitType = getLimitForRoute(method, path);
  const identity = getClientIdentity(request);
  const result = await checkRateLimit(identity, limitType);

  if (!result.allowed) {
    return rateLimitResponse(result.retryAfter!);
  }

  return handler();
}
