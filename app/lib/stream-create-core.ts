import { getStore } from "@/app/lib/db";
import { checkTokenAllowed, normaliseToken } from "@/app/lib/token-allowlist";
import { parseCreateStreamBody, type ValidationError } from "@/app/lib/stream-validation";
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
  const parseResult = parseCreateStreamBody(body);
  if (!parseResult.success) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_ERROR",
      message: "One or more fields are invalid.",
      details: parseResult.errors,
    };
  }
  const parsed = parseResult.data;

  const rawToken = parsed.token?.trim() || "XLM";
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
    rate: parsed.rate,
    recipient: parsed.recipient,
    schedule: parsed.schedule,
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
