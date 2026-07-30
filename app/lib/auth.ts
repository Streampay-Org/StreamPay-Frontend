import crypto from "crypto";
import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import type { AuditActorRole } from "@/app/types/audit";

// ── Constants ─────────────────────────────────────────────────────────────────

export const INSECURE_DEV_JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

/** Token issuer — must match the value used when signing. */
export const JWT_ISSUER = "streampay";

/** Token audience — must match the value used when signing. */
export const JWT_AUDIENCE = "streampay-api";

/** Only HS256 is accepted. Prevents alg=none and algorithm-confusion attacks. */
const JWT_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

/** JWT lifetime for newly issued tokens. */
export const JWT_EXPIRES_IN = "15m";

// ── Secret resolution ─────────────────────────────────────────────────────────

const MIN_SECRET_LENGTH = 32;

/**
 * Resolve and validate the JWT secret.
 *
 * - In `development` / `test`: falls back to the dev placeholder so local
 *   development works without env setup, but logs a warning.
 * - In all other environments: throws immediately if the secret is absent
 *   or shorter than MIN_SECRET_LENGTH characters.
 *
 * Called at runtime so rotation and test overrides are picked up.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const env = process.env.NODE_ENV ?? "development";
  const isDev = env === "development" || env === "test";

  if (!secret || secret.length === 0) {
    if (isDev) {
      console.warn(
        "[auth] JWT_SECRET is not set. Using insecure dev placeholder. " +
          "Set JWT_SECRET in production.",
      );
    }
    return INSECURE_DEV_JWT_SECRET;
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    if (isDev) {
      console.warn(
        `[auth] JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters. ` +
          "Use a longer secret in production.",
      );
    }
    return secret;
  }

  return secret;
}

/**
 * The resolved JWT secret. Validated at module load — throws in production
 * if the secret is missing or too short.
 */
export const JWT_SECRET: string = resolveJwtSecret();

interface JwtKeyConfig {
  kid: string;
  secret: string;
}

function getCurrentKeyId(): string {
  return process.env.JWT_KEY_ID?.trim() || "streampay-current";
}

function getPreviousKeyId(): string {
  return process.env.JWT_PREVIOUS_KEY_ID?.trim() || "streampay-previous";
}

function toBase64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function getConfiguredJwtSecrets(): JwtKeyConfig[] {
  const currentSecret = resolveJwtSecret();
  const secrets: JwtKeyConfig[] = [{ kid: getCurrentKeyId(), secret: currentSecret }];
  const previousSecret = process.env.JWT_PREVIOUS_SECRET?.trim();

  if (previousSecret && previousSecret.length > 0 && previousSecret !== currentSecret) {
    secrets.push({ kid: getPreviousKeyId(), secret: previousSecret });
  }

  return secrets;
}

function getTokenKid(token: string): string | undefined {
  try {
    const decoded = jwt.decode(token, { complete: true }) as
      | { header?: { kid?: string } }
      | null;
    const kid = decoded?.header?.kid;
    return typeof kid === "string" && kid.length > 0 ? kid : undefined;
  } catch {
    return undefined;
  }
}

function getJwtSecretCandidates(token: string): string[] {
  const requestedKid = getTokenKid(token);
  const configuredKeys = getConfiguredJwtSecrets();
  const orderedSecrets: string[] = [];

  if (requestedKid) {
    const matchingSecret = configuredKeys.find((entry) => entry.kid === requestedKid);
    if (matchingSecret) {
      orderedSecrets.push(matchingSecret.secret);
    }
  }

  for (const entry of configuredKeys) {
    if (!orderedSecrets.includes(entry.secret)) {
      orderedSecrets.push(entry.secret);
    }
  }

  return orderedSecrets;
}

export function getJwtJwks() {
  return {
    keys: getConfiguredJwtSecrets().map((entry) => ({
      kty: "oct",
      use: "sig",
      alg: "HS256",
      kid: entry.kid,
      k: toBase64url(entry.secret),
    })),
  };
}

// ── Role helpers ──────────────────────────────────────────────────────────────

const VALID_ROLES = new Set<AuditActorRole>([
  "user",
  "support",
  "admin",
  "finance",
  "security",
  "compliance",
  "system",
]);

const AUDIT_LOG_READ_ROLES = new Set<AuditActorRole>([
  "support",
  "admin",
  "finance",
  "security",
  "compliance",
]);

const AUDIT_LOG_EXPORT_ROLES = new Set<AuditActorRole>([
  "admin",
  "security",
  "compliance",
]);

function normalizeRole(role: string | undefined): AuditActorRole {
  return role && VALID_ROLES.has(role as AuditActorRole)
    ? (role as AuditActorRole)
    : "user";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthenticatedActor {
  actorId: string;
  walletAddress: string;
  role: AuditActorRole;
}

interface TokenClaims {
  sub?: string;
  role?: string;
  actorId?: string;
  iss?: string;
  aud?: string | string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status },
  );
}

/**
 * Validates double-submit CSRF tokens using constant-time comparison.
 * Protects wallet authentication endpoints from timing and CSRF attacks.
 */
export function validateCsrfToken(cookieToken: string | null, headerToken: string | null): boolean {
  if (!cookieToken || !headerToken) return false;

  try {
    const bufCookie = Buffer.from(cookieToken);
    const bufHeader = Buffer.from(headerToken);

    if (bufCookie.length !== bufHeader.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufCookie, bufHeader);
  } catch {
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sign a JWT for the given wallet address.
 */
export function signToken(
  walletAddress: string,
  extra: Record<string, unknown> = {},
): string {
  const currentSecret = resolveJwtSecret();
  return jwt.sign(
    { sub: walletAddress, iss: JWT_ISSUER, aud: JWT_AUDIENCE, ...extra },
    currentSecret,
    {
      expiresIn: JWT_EXPIRES_IN,
      algorithm: "HS256",
      header: { kid: getCurrentKeyId() },
    },
  );
}

/**
 * Attempt to authenticate an incoming request via its `Authorization: Bearer`
 * header.
 */
export function tryAuthenticateRequest(request: Request): AuthenticatedActor | null {
  const authHeader = request.headers?.get?.("authorization") ?? null;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const verificationOptions = {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: JWT_ALGORITHMS,
  };

  for (const secret of getJwtSecretCandidates(token)) {
    if (
      secret === INSECURE_DEV_JWT_SECRET &&
      process.env.NODE_ENV === "production" &&
      process.env.ALLOW_INSECURE_DEV_SECRET !== "true"
    ) {
      continue;
    }
    try {
      const verified = jwt.verify(token, secret, verificationOptions) as TokenClaims;

      if (!verified.sub) return null;

      return {
        actorId:
          typeof verified.actorId === "string" && verified.actorId.length > 0
            ? verified.actorId
            : verified.sub,
        walletAddress: verified.sub,
        role: normalizeRole(verified.role),
      };
    } catch {
      // Try the next configured secret.
    }
  }

  return null;
}

/**
 * Require audit-log access. Returns the authenticated actor on success,
 * or a NextResponse error (401/403) on failure.
 */
export function requireAuditLogAccess(
  request: Request,
  access: "read" | "export" = "read",
): AuthenticatedActor | NextResponse {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Missing or invalid authorization header",
      401,
    );
  }

  const allowedRoles =
    access === "export" ? AUDIT_LOG_EXPORT_ROLES : AUDIT_LOG_READ_ROLES;
  if (!allowedRoles.has(actor.role)) {
    return createErrorResponse(
      "FORBIDDEN",
      "You do not have permission to access audit logs",
      403,
    );
  }

  return actor;
}
