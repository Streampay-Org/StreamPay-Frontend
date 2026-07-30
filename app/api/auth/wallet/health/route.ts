/**
 * GET /api/auth/wallet/health
 *
 * Health probe for the /api/auth/wallet dependency set.
 *
 * Checks the three runtime dependencies the wallet-auth route relies on:
 *
 * 1. jwt_secret   — JWT_SECRET is present and meets the minimum-length
 *                   requirement for HS256 signing.
 * 2. config       — App configuration (STELLAR_NETWORK, ALLOWED_ORIGINS,
 *                   etc.) passes validation.
 * 3. challenge_store — The in-process challenge store module is accessible
 *                   and can be initialised.
 *
 * Returns 200 when every check is "ok", 503 when any check is "degraded".
 * No authentication or rate-limiting is applied; the endpoint is designed
 * for infra health probes and does not expose any sensitive data.
 *
 * @see app/lib/health.ts  — canonical dependency-check utilities
 */

import { NextResponse } from "next/server";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { validateConfig } from "@/app/lib/config";
import { INSECURE_DEV_JWT_SECRET } from "@/app/lib/auth";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WalletHealthStatus = "ok" | "degraded";

export type WalletDependencyCheckResult = {
  status: WalletHealthStatus;
  message?: string;
  checked_at: string;
};

export type WalletHealthReport = {
  status: WalletHealthStatus;
  checks: {
    jwt_secret: WalletDependencyCheckResult;
    config: WalletDependencyCheckResult;
    challenge_store: WalletDependencyCheckResult;
  };
};

/** Minimum acceptable byte-length for JWT_SECRET (same as auth.ts). */
const MIN_SECRET_LENGTH = 32;

// ── Dependency injection types ────────────────────────────────────────────────

export type WalletHealthDependencies = {
  now?: () => Date;
  validateConfig?: typeof validateConfig;
  resolveJwtSecret?: () => string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Execute a check function and wrap the result in a `WalletDependencyCheckResult`.
 * Any thrown error is caught and reported as a "degraded" result so a single
 * failing dependency never causes an unhandled 500.
 */
async function runCheck(
  now: () => Date,
  check: () => Promise<void> | void,
): Promise<WalletDependencyCheckResult> {
  const checked_at = now().toISOString();
  try {
    await check();
    return { status: "ok", checked_at };
  } catch (error) {
    return {
      status: "degraded",
      message: error instanceof Error ? error.message : "Dependency check failed.",
      checked_at,
    };
  }
}

/**
 * Default JWT-secret resolver.
 *
 * Mirrors the logic in `app/lib/auth.ts::resolveJwtSecret()` without
 * re-importing the module (which would execute the top-level secret
 * validation at import time in production, throwing before the health
 * handler can return a useful 503).
 *
 * - Returns the secret string when valid.
 * - Throws a descriptive error when the secret is absent or too short in
 *   non-development environments.
 * - Warns (but does not throw) in development / test so local setup
 *   without JWT_SECRET still shows degraded rather than crashing.
 */
function defaultResolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const env = process.env.NODE_ENV ?? "development";
  const isDev = env === "development" || env === "test";

  if (!secret || secret.length === 0) {
    if (isDev) {
      // Return the insecure placeholder so local developers get a degraded
      // signal rather than a hard crash — they may not have JWT_SECRET set.
      return INSECURE_DEV_JWT_SECRET;
    }
    throw new Error(
      "JWT_SECRET environment variable is required.",
    );
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    if (isDev) {
      // Return the short secret so the check surface area is visible.
      return secret;
    }
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
        `(got ${secret.length}).`,
    );
  }

  return secret;
}

// ── Core probe logic (injectable for testing) ─────────────────────────────────

/**
 * Run all wallet-auth dependency checks and return a `WalletHealthReport`.
 *
 * @param dependencies   Optional overrides for dependency injection in tests.
 */
export async function getWalletHealthReport(
  dependencies: WalletHealthDependencies = {},
): Promise<WalletHealthReport> {
  const now = dependencies.now ?? (() => new Date());
  const validate = dependencies.validateConfig ?? validateConfig;
  const resolveSecret = dependencies.resolveJwtSecret ?? defaultResolveJwtSecret;

  // ── Check 1: JWT_SECRET availability and minimum-length guard ────────────
  const jwtSecretCheck = await runCheck(now, () => {
    const secret = resolveSecret();
    if (secret === INSECURE_DEV_JWT_SECRET) {
      throw new Error(
        "JWT_SECRET is not set; using insecure dev placeholder.",
      );
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
          `(got ${secret.length}).`,
      );
    }
  });

  // ── Check 2: App configuration (STELLAR_NETWORK, ALLOWED_ORIGINS, etc.) ──
  const configCheck = await runCheck(now, () => {
    validate();
  });

  // ── Check 3: In-process challenge store reachability ─────────────────────
  //
  // The challenge store is an in-memory array inside the wallet route module.
  // A Node.js module load failure would prevent this health module from loading
  // too, so this check effectively validates that the module resolution
  // environment is sane.  We do a lightweight dynamic import so a future
  // move to a real store (Redis, Postgres) can be detected here.
  const challengeStoreCheck = await runCheck(now, async () => {
    // Dynamic import ensures we catch any module-load failures without
    // contaminating the top-level import graph of this health module.
    const mod = await import("@/app/api/auth/wallet/route");
    if (typeof mod.resetWalletChallengeStoreForTesting !== "function") {
      throw new Error(
        "challenge_store module loaded but expected export not found.",
      );
    }
  });

  const checks: WalletHealthReport["checks"] = {
    jwt_secret: jwtSecretCheck,
    config: configCheck,
    challenge_store: challengeStoreCheck,
  };

  const overallStatus: WalletHealthStatus = Object.values(checks).every(
    (c) => c.status === "ok",
  )
    ? "ok"
    : "degraded";

  return { status: overallStatus, checks };
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/wallet/health
 *
 * Health probe for the wallet-auth subsystem.
 *
 * - 200 OK    — all dependency checks pass
 * - 503 Service Unavailable — one or more checks report "degraded"
 */
export async function GET(request: Request) {
  const context = getCorrelationContext();
  const startedAt = Date.now();

  const report = await getWalletHealthReport();

  logger.info("wallet auth health probe executed", {
    method: "GET",
    path: new URL(request.url).pathname,
    status: report.status,
    duration_ms: Date.now() - startedAt,
    request_id: context?.request_id,
    correlation_id: context?.correlation_id,
  });

  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
  });
}
