/**
 * Auth Wallet Validation Module
 *
 * Zod-validated request schemas for GET and POST /api/auth/wallet.
 * Follows stream-validation.ts: validators return structured
 * `ValidationError` arrays so the calling route can return
 * 422 VALIDATION_ERROR with per-field details.
 */

import { z } from "zod";
import { isValidStellarPublicKey } from "@/app/lib/wallet-link";
import type { ValidationError } from "@/app/lib/stream-validation";

/**
 * Challenges are issued by GET /api/auth/wallet in exactly this shape:
 * `streampay-auth:v1:<nonce>|<origin>|<expires_at>` — a base64url CSPRNG
 * nonce (43+ chars), the server origin, and the ISO-8601 expiry.
 */
export const CHALLENGE_PATTERN =
  /^streampay-auth:v1:[A-Za-z0-9_-]{43,}\|[^|]{1,200}\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Upper bounds so oversized payloads never reach signature verification. */
export const MAX_CHALLENGE_LENGTH = 256;
export const MAX_SIGNATURE_LENGTH = 1024;

/** Checksum-validated strkey, not just the G... shape. */
const stellarAddress = z
  .string()
  .refine(isValidStellarPublicKey, {
    message: "must be a valid Stellar public key.",
  });

export const walletChallengeQuerySchema = z.object({
  address: stellarAddress,
});

export const walletVerifyBodySchema = z.object({
  address: stellarAddress,
  challenge: z
    .string()
    .max(
      MAX_CHALLENGE_LENGTH,
      `must be at most ${MAX_CHALLENGE_LENGTH} characters.`,
    )
    .regex(
      CHALLENGE_PATTERN,
      "must be a challenge issued by GET /api/auth/wallet.",
    ),
  signature: z
    .string()
    .min(1, "must not be empty.")
    .max(
      MAX_SIGNATURE_LENGTH,
      `must be at most ${MAX_SIGNATURE_LENGTH} characters.`,
    ),
});

function toValidationErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

/**
 * Validates the query params for GET /api/auth/wallet.
 *
 * @returns An array of `ValidationError`. An empty array means success.
 */
export function validateWalletChallengeQuery(
  query: unknown,
): ValidationError[] {
  const result = walletChallengeQuerySchema.safeParse(query);
  return result.success ? [] : toValidationErrors(result.error);
}

/**
 * Validates the request body for POST /api/auth/wallet.
 *
 * @returns An array of `ValidationError`. An empty array means success.
 */
export function validateWalletVerifyBody(body: unknown): ValidationError[] {
  const result = walletVerifyBodySchema.safeParse(body);
  return result.success ? [] : toValidationErrors(result.error);
}
