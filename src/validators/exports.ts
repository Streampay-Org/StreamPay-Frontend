import { z } from "zod";

/**
 * Zod schema for validating the request body for POST /api/exports.
 *
 * - `format`: Optional, format of the export (csv or json). Defaults to csv.
 * - `startDate`: Optional, ISO 8601 datetime string to filter exports from.
 * - `endDate`: Optional, ISO 8601 datetime string to filter exports to.
 *
 * The schema is `strict`, meaning any unknown fields will be rejected.
 */
export const exportRequestSchema = z
  .object({
    format: z.enum(["csv", "json"]).optional().default("csv"),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .strict("Unknown fields are not allowed.");

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

/**
 * Validates the request body for POST /api/exports using Zod.
 *
 * @param body The raw request body.
 * @returns A discriminated union indicating success with parsed data or failure with an array of `ValidationError`.
 */
export function validateExportRequest(
  body: unknown,
): { success: true; data: z.infer<typeof exportRequestSchema> } | { success: false; errors: ValidationError[] } {
  const result = exportRequestSchema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      code: issue.code.toUpperCase(),
      message: issue.message,
    })),
  };
}
