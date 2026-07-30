/**
 * Stream Validation Module
 *
 * Shared request-body validation for POST /api/streams handlers (v1 & v2).
 * Ensures recipient, rate, and schedule meet Stellar network requirements
 * before the stream is persisted.
 *
 * All validators return structured error arrays so the calling route can
 * return 422 VALIDATION_ERROR with per-field details.
 */

import { isValidStellarPublicKey } from "@/app/lib/wallet-link";
import { z } from "zod";
import type { StreamStatus } from "@/app/types/openapi";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Schedule values supported by the schedule engine.
 * @see app/lib/schedules.ts — PayoutInterval type
 */
export const SUPPORTED_SCHEDULES = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

export type SupportedSchedule = (typeof SUPPORTED_SCHEDULES)[number];

/** Maximum decimal places allowed for rate (Stellar supports 7). */
const MAX_DECIMAL_PRECISION = 7;

/** Regex for a non-negative decimal number (whole or fractional). */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export interface CreateStreamBody {
  recipient: string;
  rate: string;
  schedule: string;
  token?: string;
}

/**
 * Zod schema for validating the request body for `PATCH /api/v2/streams/[id]`.
 *
 * - `description`: Optional, up to 280 characters.
 * - `webhook_url`: Optional, must be a valid URL.
 * - `tags`: Optional, array of up to 10 strings, each 1-50 characters.
 *
 * The schema is `strict`, meaning any unknown fields will be rejected.
 */
export const patchStreamSchema = z
  .object({
    description: z.string().min(1, "Description cannot be empty.").max(280).optional(),
    webhook_url: z.string().url("Must be a valid URL.").optional(),
    tags: z
      .array(
        z
          .string()
          .min(1, "Tag cannot be empty.")
          .max(50, "Tag cannot exceed 50 characters."),
      )
      .max(10, "Cannot have more than 10 tags.")
      .optional(),
  })
  .strict("Unknown fields are not allowed.");


// ── Validator ──────────────────────────────────────────────────────────────

function zodIssuesToErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => {
    const params = (issue as { params?: { code?: unknown } }).params;
    return {
      field: issue.path.join(".") || "body",
      code:
        typeof params?.code === "string" ? params.code : issue.code.toUpperCase(),
      message: issue.message,
    };
  });
}

/**
 * Zod schema for the POST /api/streams body.
 *
 * The field rules and error codes are the long-standing contract of
 * `validateCreateStreamBody`; each violation is emitted as a custom issue
 * carrying its code in `params`, so callers see identical errors.
 */
export const createStreamSchema = z
  .record(z.unknown())
  .superRefine((body, ctx) => {
    const fail = (path: string, code: string, message: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
        params: { code },
      });

    const recipient = body.recipient;
    if (typeof recipient !== "string" || recipient.trim().length === 0) {
      fail(
        "recipient",
        "MISSING_FIELD",
        "recipient is required and must be a non-empty string.",
      );
    } else if (!isValidStellarPublicKey(recipient.trim())) {
      fail(
        "recipient",
        "INVALID_STELLAR_KEY",
        "recipient must be a valid Stellar public key (56-char string starting with G).",
      );
    }

    const rate = body.rate;
    if (typeof rate !== "string" || rate.trim().length === 0) {
      fail("rate", "MISSING_FIELD", "rate is required and must be a non-empty string.");
    } else {
      const trimmed = rate.trim();

      if (!DECIMAL_PATTERN.test(trimmed)) {
        fail(
          "rate",
          "INVALID_RATE_FORMAT",
          "rate must be a positive decimal number (e.g. 100 or 50.5).",
        );
      } else {
        if (Number(trimmed) <= 0) {
          fail("rate", "NEGATIVE_RATE", "rate must be greater than zero.");
        }

        const fractionPart = trimmed.split(".")[1] ?? "";
        if (fractionPart.length > MAX_DECIMAL_PRECISION) {
          fail(
            "rate",
            "DECIMAL_PRECISION_EXCEEDED",
            `rate supports at most ${MAX_DECIMAL_PRECISION} decimal places.`,
          );
        }
      }
    }

    const schedule = body.schedule;
    if (typeof schedule !== "string" || schedule.trim().length === 0) {
      fail(
        "schedule",
        "MISSING_FIELD",
        "schedule is required and must be a non-empty string.",
      );
    } else if (
      !SUPPORTED_SCHEDULES.includes(
        schedule.trim().toLowerCase() as SupportedSchedule,
      )
    ) {
      fail(
        "schedule",
        "INVALID_SCHEDULE",
        `schedule must be one of: ${SUPPORTED_SCHEDULES.join(", ")}.`,
      );
    }

    const token = body.token;
    if (token !== undefined && token !== null && typeof token !== "string") {
      fail("token", "INVALID_TOKEN_FORMAT", "token must be a string if provided.");
    }
  });

/**
 * Validates the request body for POST /api/streams.
 *
 * Returns an array of field-level errors. An empty array means the body is
 * valid (though the caller still needs to handle token allowlisting etc.).
 */
export function validateCreateStreamBody(
  body: Record<string, unknown>,
): ValidationError[] {
  const result = createStreamSchema.safeParse(body);
  return result.success ? [] : zodIssuesToErrors(result.error);
}

// ── GET /api/streams query ─────────────────────────────────────────────────

export const STREAM_STATUSES = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const satisfies readonly StreamStatus[];

/**
 * Zod schema for the GET /api/streams query params. Values arrive as URL
 * strings; `limit` is returned as a number. Unknown params are ignored by
 * the caller, and cursor decoding stays a separate semantic check
 * (INVALID_CURSOR) in the route.
 */
export const listStreamsQuerySchema = z.object({
  limit: z
    .string()
    .superRefine((value, ctx) => {
      const fail = (message: string) =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          params: { code: "INVALID_LIMIT" },
        });

      if (!/^\d+$/.test(value)) {
        fail("limit must be a positive integer.");
        return;
      }
      const parsed = Number(value);
      if (parsed < 1 || parsed > 100) {
        fail("limit must be between 1 and 100.");
      }
    })
    .transform(Number)
    .optional(),
  status: z
    .string()
    .superRefine((value, ctx) => {
      if (!(STREAM_STATUSES as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `status must be one of: ${STREAM_STATUSES.join(", ")}.`,
          params: { code: "INVALID_STATUS" },
        });
      }
    })
    .transform((value) => value as StreamStatus)
    .optional(),
  cursor: z
    .string()
    .superRefine((value, ctx) => {
      if (value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cursor must not be empty.",
          params: { code: "INVALID_CURSOR" },
        });
      }
    })
    .optional(),
});

export type ListStreamsQuery = z.infer<typeof listStreamsQuerySchema>;

/**
 * Validates the query params for GET /api/streams.
 *
 * Returns field-level errors plus the parsed values on success.
 */
export function validateListStreamsQuery(query: Record<string, unknown>): {
  errors: ValidationError[];
  values: ListStreamsQuery;
} {
  const result = listStreamsQuerySchema.safeParse(query);
  if (result.success) {
    return { errors: [], values: result.data };
  }
  return { errors: zodIssuesToErrors(result.error), values: {} };
}

/**
 * Validates the request body for PATCH /api/v2/streams/[id] using Zod.
 *
 * @param body The raw request body.
 * @returns An array of `ValidationError`. An empty array means success.
 */
export function validatePatchStreamBody(
  body: unknown,
): ValidationError[] {
  const result = patchStreamSchema.safeParse(body);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}
