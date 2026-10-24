import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { getStore, withLock } from "@/app/lib/db";
import { toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";
import { transition } from "@/app/lib/state-machine";
import { patchStreamSchema } from "@/app/lib/validation";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit";
import { computeFingerprint } from "@/app/lib/idompotency";
import { getCorrelationContext } from "@/app/lib/logger";
import { inferStreamChangeAction, publishStreamChange } from "@/app/lib/stream-publish";
import type { Stream, StreamAction } from "@/app/types/openapi";

const BATCHABLE_ACTIONS = ["start", "pause", "stop", "settle"] as const;
const NON_BATCHABLE_ACTIONS = ["withdraw", "cancel"] as const;
const IDOEMATENCY_SCOPE = "v2.streams.batch";

const batchUpdateItemSchema = z.object({
  id: z.string().min(1),
  data: z.record(z.unknown()),
}).strict();

const batchRequestSchema = z.object({
  updates: z.array(batchUpdateItemSchema),
}).strict();

interface BatchUpdateRequest {
  updates: Array<{
    id: string;
    data: Record<string, unknown>;
  }>;
}

interface BatchError {
  index: number;
  id?: string;
  code: string;
  message: string;
}

interface DataShapeResult {
  error?: BatchError;
  action?: StreamAction;
  metadata?: Record<string, unknown>;
}

function validateDataShape(
  data: Record<string, unknown>,
  index: number,
  id: string
): DataShapeResult {
  const keys = Object.keys(data);
  const allowedKeys = new Set<string>(["action", ...Object.keys(patchStreamSchema.shape)]);

  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return {
        error: {
          index,
          id,
          code: ErrorCode.UNKNOWN_FIELD ?? "UNKNOWN_FIELD",
          message: `Unknown field '${key}' in data for stream '${id}'.`,
        },
      };
    }
  }

  const { action, ...rest } = data as { action?: unknown } & Record<string, unknown>;

  if (action !== undefined) {
    if (typeof action !== "string") {
      return {
        error: {
          index,
          id,
          code: ErrorCode.VALIDATION_ERROR ?? "VALIDATION_ERROR",
          message: `Action must be a string for stream '${id}'.`,
        },
      };
    }
    if ((NON_BATCHABLE_ACTIONS as readonly string[]).includes(action)) {
      return {
        error: {
          index,
          id,
          code: "ACTION_NOT_BATCHABLE",
          message: `Action '${action}' is not allowed in a batch request.`,
        },
      };
    }
    if (!(BATCHABLE_ACTIONS as readonly string[]).includes(action)) {
      return {
        error: {
          index,
          id,
          code: ErrorCode.VALIDATION_ERROR ?? "VALIDATION_ERROR",
          message: `Unknown action '${action}' for stream '${id}'.`,
        },
      };
    }
  }

  if (Object.keys(rest).length > 0) {
    const parsed = patchStreamSchema.safeParse(rest);
    if (!parsed.success) {
      return {
        error: {
          index,
          id,
          code: ErrorCode.VALIDATION_ERROR ?? "VALIDATION_ERROR",
          message: `Invalid metadata for stream '${id}': ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        },
      };
    }
    return {
      action: action as StreamAction | undefined,
      metadata: parsed.data as Record<string, unknown>,
    };
  }

  return { action: action as StreamAction | undefined, metadata: {} };
}

/**
 * POST /api/v2/streams/batch
 *
 * Batch update up to 100 streams in a single transaction.
 * Requires: Authorization: Bearer <token>
 *
 * Body: { "updates": [ { "id": "stream-1", "data": { "action": "pause" } } ] }
 * Response: { "streams": StreamV2[] } (200)
 *
 * Status changes are applied through the lifecycle state machine via
 * `data.action`. Raw `status` keys are rejected with 400 UNKNOWN_FIELD.
 * `withdraw` and `cancel` are not batchable (they move funds) and are
 * rejected with 422 ACTION_NOT_BATCHABLE. Side fields (`pausedAt`,
 * `nextAction`) are applied identically to the single-stream routes.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return errorResponse(ErrorCode.UNAUTHORIZED, "Bearer token required.", 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(ErrorCode.BAD_REQUEST, "Invalid JSON body.", 400);
  }

  const parsedBody = batchRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return errorResponse(ErrorCode.BAD_REQUEST, "Invalid request body.", 400);
  }

  const { updates } = parsedBody.data as BatchUpdateRequest;

  if (updates.length === 0) {
    return NextResponse.json({ streams: [] }, { status: 200 });
  }

  if (updates.length > 100) {
    return errorResponse(ErrorCode.BADMESSAGE, "Too many updates.", 400);
  }

  // Reject duplicate ids before acquiring any locks.
  const seenIds = new Set<string>();
  const duplicateErrors: BatchError[] = [];
  for (let i = 0; i < updates.length; i++) {
    const { id } = updates[i];
    if (seenIds.has(id)) {
      duplicateErrors.push({
        index: i,
        id,
        code: "DUPLICATE_ID",
        message: `Stream '${id}' appears more than once in the batch.`,
      });
    }
    seenIds.add(id);
  }
  if (duplicateErrors.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "One or more stream updates failed validation. No changes were applied.",
          details: duplicateErrors,
          request_id: req.headers.get("x-request-id") || "unknown",
        },
      },
      { status: 422 }
    );
  }

  // Validate the shape of each update before acquiring locks.
  const shapeErrors: BatchError[] = [];
  const prepared = updates.map((update, index) => {
    const result = validateDataShape(update.data, index, update.id);
    if (result.error) {
      shapeErrors.push(result.error);
    }
    return {
      id: update.id,
      action: result.action,
      metadata: result.metadata ?? {},
    };
  });
  if (shapeErrors.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "One or more stream updates failed validation. No changes were applied.",
          details: shapeErrors,
          request_id: req.headers.get("x-request-id") || "unknown",
        },
      },
      { status: 422 }
    );
  }

  // Sort unique IDs to prevent deadlocks when acquiring locks sequentially
  const uniqueIds = Array.from(seenIds).sort();

  // Helper to recursively acquire locks
  async function acquireLocksAndExecute(index: number, action: () => Promise<NextResponse>): Promise<NextResponse> {
    if (index >= uniqueIds.length) {
      return action();
    }
    return withLock(uniqueIds[index], () => acquireLocksAndExecute(index + 1, action));
  }

  const idempotencyKey = req.headers.get("idempotency-key");
  const fingerprint = computeFingerprint(rawBody);

  return acquireLocksAndExecute(0, async () => {
    const { streamRepository, idompotencyRepository } = getStore();

    if (idempotencyKey) {
      const existing = idompotencyRepository?.get(IDOEMATENCY_SCOPE, idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return errorResponse(
            "IDEMPOTENCY_CONFLICT" as ErrorCode,
            "Idempotency-Key was reused with a different request body.",
            409
          );
        }
        return NextResponse.json(existing.responseBody, { status: existing.statusCode });
      }
    }

    const errors: BatchError[] = [];
    const planned: Array<{
      index: number;
      id: string;
      action?: StreamAction;
      metadata: Record<string, unknown>;
      existing: Stream;
      nextStatus?: string;
    }> = [];

    // Validation phase (Dry run)
    for (let i = 0; i < prepared.length; i++) {
      const { id, action, metadata } = prepared[i];
      const stream = streamRepository.streams.get(id);

      if (!stream) {
        errors.push({
          index: i,
          id,
          code: ErrorCode.STREAM_NOT_FOUND,
          message: `Stream '${id}' not found.`,
        });
        continue;
      }

      let nextStatus: string | undefined;
      if (action) {
        const result = transition(stream.status as any, action as any);
        if (!result.ok) {
          errors.push({
            index: i,
            id,
            code: "ILLEGAL_TRANSITION",
            message: `Illegal transition from '${stream.status}' via '${action}' for stream '${id}'.`,
          });
          continue;
        }
        nextStatus = result.next as unknown as string;
      }

      planned.push({ index: i, id, action, metadata, existing: stream as unknown as Stream, nextStatus });
    }

    // All-or-nothing: if any error is found, roll back (apply no changes) and return 422
    if (errors.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "One or more stream updates failed validation. No changes were applied.",
            details: errors,
            request_id: req.headers.get("x-request-id") || "unknown",
          },
        },
        { status: 422 }
      );
    }

    // Execution phase
    const now = new Date().toISOString();
    const updatedStreams: unknown[] = [];
    const auditEvents: Array<{ id: string; action?: StreamAction; prevStatus: string; nextStatus: string }> = [];

    for (const item of planned) {
      const existing = item.existing;
      const nextStatus = item.nextStatus ?? existing.status;
      const updatedStream: Record<string, unknown> = {
        ...(existing as unknown as Record<string, unknown>),
        ...item.metadata,
        status: nextStatus,
        updatedAt: now,
      };

      if (item.action) {
        if (item.action === "pause") {
          updatedStream.pausedAt = now;
        } else if (item.action === "start") {
          updatedStream.pausedAt = null;
        }
        updatedStream.nextAction = deriveNextAction(nextStatus);
      }

      streamRepository.streams.set(item.id, updatedStream as unknown as Stream);

      publishStreamChange({
        action: inferStreamChangeAction(existing, updatedStream as Stream),
        actor: req.headers.get("Actor-Wallet-Address") ?? undefined,
        after: updatedStream as Stream,
        before: existing,
        correlationId: getCorrelationContext()?.correlation_id,
      });

      updatedStreams.push(toV2Stream(dbStreamToV1(updatedStream as unknown as Stream)));

      if (item.action) {
        auditEvents.push({
          id: item.id,
          action: item.action,
          prevStatus: existing.status,
          nextStatus,
        });
      }
    }

    for (const event of auditEvents) {
      recordPrivilegedStreamAuditEvent({
        streamId: event.id,
        action: `stream.batch.${event.action}`,
        metadata: {
          prevStatus: event.prevStatus,
          nextStatus: event.nextStatus,
        },
      });
    }

    const responseBody = { streams: updatedStreams };

    if (idempotencyKey && idompotencyRepository?.set) {
      idompotencyRepository.set(IDOEMATENCY_SCOPE, idempotencyKey, {
        fingerprint,
        statusCode: 200,
        responseBody,
      });
    }

    return NextResponse.json(responseBody, { status: 200 });
  });
}

function deriveNextAction(status: string): string | null {
  switch (status) {
    case "active":
      return "pause";
    case "paused":
      return "start";
    case "ended":
      return "settle";
    default:
      return null;
  }
}