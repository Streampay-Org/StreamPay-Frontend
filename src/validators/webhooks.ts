import { z } from "zod";

const nonEmptyTrimmedString = (field: string) =>
  z
    .string({
      required_error: `${field} is required`,
      invalid_type_error: `${field} must be a string`,
    })
    .trim()
    .min(1, `${field} is required`);

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const webhookHeadersSchema = z.record(nonEmptyTrimmedString("header value")).optional();

export const webhookPayloadSchema = z
  .object({
    eventType: nonEmptyTrimmedString("eventType"),
    eventId: nonEmptyTrimmedString("eventId").optional(),
    timestamp: z.string().datetime().optional(),
    source: nonEmptyTrimmedString("source").optional(),
    data: jsonValueSchema.optional(),
    metadata: z.record(jsonValueSchema).optional(),
    headers: webhookHeadersSchema,
  })
  .strict("Unknown fields are not allowed.");

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
