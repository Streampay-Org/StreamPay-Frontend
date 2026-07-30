/**
 * Reconciliation query validation (Issue #1136).
 *
 * Zod schemas for GET /api/reconciliation query params. Validators return
 * structured `ValidationError` arrays so the route can emit the standard
 * 422 VALIDATION_ERROR envelope with per-field details and correlation IDs.
 */

import { z } from "zod";
import type { ValidationError } from "@/app/lib/stream-validation";

/** Optional integer limit in [1, 1000]. Defaults applied by the route when absent. */
export const reconciliationQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || Number.isNaN(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be an integer between 1 and 1000",
        });
        return z.NEVER;
      }
      if (parsed < 1 || parsed > 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be an integer between 1 and 1000",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  cursor: z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim().length > 0, {
      message: "must not be empty",
    }),
  status: z
    .enum(["pending", "completed", "failed"])
    .optional(),
});

export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;

function toValidationErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "query",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

/**
 * Validates GET /api/reconciliation query params.
 *
 * @returns `{ ok: true, data }` on success, or `{ ok: false, errors }` on failure.
 */
export function validateReconciliationQuery(
  query: unknown
):
  | { ok: true; data: ReconciliationQuery }
  | { ok: false; errors: ValidationError[] } {
  const result = reconciliationQuerySchema.safeParse(query);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: toValidationErrors(result.error) };
}
