import { getStore } from "@/app/lib/db";
import { newStreamId } from "@/app/lib/stream-id";
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
    }
  | {
      ok: false;
      status: 500;
      code: "ID_GENERATION_FAILED";
      message: string;
      details?: undefined;
    };

/** Attempts at drawing a fresh stream id before giving up on a collision. */
const MAX_ID_ATTEMPTS = 3;

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
  const draft: Stream = {
    createdAt: now,
    id: "",
    nextAction: "start",
    rate: parsed.rate,
    recipient: parsed.recipient,
    schedule: parsed.schedule,
    status: "draft",
    updatedAt: now,
    token,
    ...(options.extras ?? {}),
  };

  if (options.dryRun) {
    // Previews are never persisted; give them a distinct, non-colliding prefix.
    const previewId = newStreamId().replace(/^stream-/, "preview-");
    return { ok: true, stream: { ...draft, id: previewId } };
  }

  // Create-only insert: an id collision must never overwrite an existing
  // stream, so draw a fresh id and retry a bounded number of times.
  const { streams } = getStore().streamRepository;
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const stream: Stream = { ...draft, id: newStreamId() };
    if (streams.insert(stream.id, stream)) {
      return { ok: true, stream };
    }
  }

  return {
    ok: false,
    status: 500,
    code: "ID_GENERATION_FAILED",
    message: "Failed to generate unique stream identifier",
  };
}
