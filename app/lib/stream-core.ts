import { getStore } from "@/app/lib/db";
import { logger } from "@/app/lib/logger";
import { checkTokenAllowed, checkTokenAllowedForOrg, normaliseToken } from "@/app/lib/token-allowlist";
import { validateCreateStreamBody, type ValidationError } from "@/app/lib/stream-validation";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import type { Stream } from "@/app/types/openapi";

export interface CreateStreamCoreInput {
  body: unknown;
  actorWallet?: string | null;
  senderAddress?: string | null;
  ownership?: "individual" | "org" | "unclaimed";
  org?: { tokenAllowlist?: string[] };
  /**
   * Optional pre-persistence hook (e.g. v2 daily quota check) invoked ONLY
   * after schema validation and token allowlist checks succeed.
   */
  beforePersist?: () => Promise<
    | { ok: true }
    | { ok: false; response: Response }
  >;
}

export type CreateStreamCoreResult =
  | {
      ok: true;
      stream: Stream;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details?: ValidationError[];
      response?: Response;
    };

/**
 * Validates stream creation inputs, normalises the token, enforces allowlists,
 * runs any optional pre-persistence gate (such as daily quota), persists the
 * new stream entity, and appends a lifecycle creation event.
 *
 * Shared by both v1 and v2 stream creation handlers.
 */
export async function createStreamCore(
  input: CreateStreamCoreInput,
): Promise<CreateStreamCoreResult> {
  const { body, actorWallet, senderAddress, ownership, org, beforePersist } = input;

  // 1. Schema validation
  const validationErrors = validateCreateStreamBody(body);
  if (validationErrors.length > 0) {
    logger.warn("Stream creation validation failed", {
      errors: validationErrors,
    });
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_ERROR",
      message: "One or more fields are invalid.",
      details: validationErrors,
    };
  }

  const { rate, recipient, schedule, token: rawToken } = body as {
    rate: string;
    recipient: string;
    schedule: string;
    token?: string;
  };

  const tokenStr = rawToken?.trim() || "XLM";

  // 2. Token format normalisation
  let normalisedToken: string;
  try {
    normalisedToken = normaliseToken(tokenStr);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    return {
      ok: false,
      status: 422,
      code: "INVALID_TOKEN",
      message: `Invalid token format: ${msg}`,
    };
  }

  // 3. Token allowlist check (org-specific if org provided, otherwise global)
  const allowlistResult = org
    ? await checkTokenAllowedForOrg(normalisedToken, org)
    : await checkTokenAllowed(normalisedToken);

  if (!allowlistResult.accepted) {
    logger.warn("Stream creation rejected: token not in allowlist", {
      token: normalisedToken,
    });
    return {
      ok: false,
      status: 422,
      code: "TOKEN_NOT_ALLOWED",
      message: allowlistResult.reason,
    };
  }

  // 4. Optional pre-persistence gate (e.g. per-org daily quota)
  if (beforePersist) {
    const gate = await beforePersist();
    if (!gate.ok) {
      return {
        ok: false,
        status: gate.response.status,
        code: "QUOTA_EXCEEDED",
        message: "Quota exceeded.",
        response: gate.response,
      };
    }
  }

  // 5. Persistence
  const store = getStore();
  const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const newStream: Stream = {
    id,
    recipient,
    rate,
    schedule,
    status: "draft",
    nextAction: "start",
    createdAt: now,
    updatedAt: now,
    token: normalisedToken,
    senderAddress: senderAddress ?? null,
    ownership: ownership ?? "unclaimed",
  };

  store.streamRepository.streams.set(id, newStream);

  // 6. Append lifecycle history event
  appendStreamHistoryEvent({
    streamId: id,
    type: "created",
    toStatus: "draft",
    at: now,
    actorWallet: actorWallet ?? senderAddress ?? null,
  });

  return {
    ok: true,
    stream: newStream,
  };
}
