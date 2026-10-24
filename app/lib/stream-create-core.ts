import { getStore } from "@/app/lib/db";
import { checkTokenAllowed, normaliseToken } from "@/app/lib/token-allowlist";
import { validateCreateStreamBody, type ValidationError } from "@/app/lib/stream-validation";
import type { Stream } from "@/app/types/openapi";

export type CreateStreamCoreResult =
  | { ok: true; stream: Stream }
  | {
      ok: false;
      status: 422;
      code: "VALIDATION_ERROR" | "INVALID_TOKEN" | "TOKEN_NOT_ALLOWED";
      message: string;
      details?: ValidationError[];
    };

export async function createStreamCore(
  body: Record<string, unknown>,
  options: { dryRun: boolean; extras?: Partial<Stream> },
): Promise<CreateStreamCoreResult> {
  const validationErrors = validateCreateStreamBody(body);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_ERROR",
      message: "One or more fields are invalid.",
      details: validationErrors,
    };
  }

  const rawToken = (body.token as string | undefined)?.trim() || "XLM";
  let token: string;
  try {
    token = normaliseToken(rawToken);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 422,
      code: "INVALID_TOKEN",
      message: `Invalid token format: ${message}`,
    };
  }

  const allowlistResult = await checkTokenAllowed(token);
  if (!allowlistResult.accepted) {
    return {
      ok: false,
      status: 422,
      code: "TOKEN_NOT_ALLOWED",
      message: allowlistResult.reason,
    };
  }

  const now = new Date().toISOString();
  const stream: Stream = {
    createdAt: now,
    id: `${options.dryRun ? "preview" : "stream"}-${crypto.randomUUID().slice(0, 8)}`,
    nextAction: "start",
    rate: (body.rate as string).trim(),
    recipient: (body.recipient as string).trim(),
    schedule: (body.schedule as string).trim().toLowerCase(),
    status: "draft",
    updatedAt: now,
    token,
    ...(options.extras ?? {}),
  };

  if (!options.dryRun) {
    getStore().streamRepository.streams.set(stream.id, stream);
  }

  return { ok: true, stream };
}
