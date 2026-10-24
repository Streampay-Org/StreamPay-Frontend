import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  db,
  idempotencyToken,
  setIdempotency,
  withLock,
} from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { enforceStreamRbac, resolveActorAddress } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { enqueueStreamLifecycleWebhook } from "@/app/lib/stream-webhook-lifecycle";
import { publishStreamChange } from "@/app/lib/stream-publish";

type Context = { params: Promise<{ id: string }> };

function createErrorResponse(code: string, message: string, status: number, legacyCode?: string) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, ...(legacyCode ? { legacy_code: legacyCode } : {}), message, request_id: context?.request_id } },
    { status },
  );
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

/**
 * POST /api/streams/:id/stop
 *
 * Stops an active or draft stream.
 *
 * Actor resolution order:
 * 1. Verified JWT `sub` claim (Bearer token).
 * 2. `Actor-Wallet-Address` header (fallback only when STREAMPAY_ALLOW_ACTOR_HEADER=true).
 * If both are present and differ, returns 403 ACTOR_MISMATCH.
 *
 * RBAC ordering:
 * Runs after 404 stream existence check and before state transition validation,
 * inside the stream lock.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const idempotencyKey = getHeader(request, "Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken(`streams.stop.${id}`, idempotencyKey)
    : null;

  const fingerprint = computeFingerprint("POST", `/api/streams/${id}/stop`, null);

  if (token) {
    const cached = checkIdempotency(db.idempotency, token, fingerprint);
    if (cached) {
      if (!cached.ok) {
        return NextResponse.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request." } },
          { status: 409 },
        );
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  return withLock(id, async () => {
    if (token) {
      const cached = checkIdempotency(db.idempotency, token, fingerprint);
      if (cached) {
        if (!cached.ok) {
          return NextResponse.json(
            { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request." } },
            { status: 409 },
          );
        }
        return NextResponse.json(cached.body, { status: cached.status });
      }
    }

    const stream = db.streams.get(id);
    if (!stream) {
      return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
    }

    // RBAC: evaluated inside the lock, immediately after 404 and before state guard.
    const rbacError = enforceStreamRbac(request, id, "stop");
    if (rbacError) return rbacError;

    const result = transition(stream.status, "stop");
    if (!result.ok) {
      return createErrorResponse(
        result.code,
        result.error,
        409,
        "INVALID_STREAM_STATE",
      );
    }

    if (result.nextStatus === stream.status) {
      return NextResponse.json({ data: stream });
    }

    const before = structuredClone(stream);
    const now = new Date().toISOString();
    const updatedStream = {
      ...stream,
      nextAction: "withdraw" as const,
      status: "ended" as const,
      updatedAt: now,
    };
    db.streams.set(id, updatedStream);

    let actorAddress: string | null = null;
    try {
      actorAddress = resolveActorAddress(request);
    } catch {
      actorAddress = getHeader(request, "Actor-Wallet-Address");
    }

    appendStreamHistoryEvent({
      streamId: id,
      type: "stopped",
      fromStatus: stream.status,
      toStatus: "ended",
      at: now,
      actorWallet: actorAddress ?? undefined,
    });
    publishStreamChange({
      action: "stop",
      actor: actorAddress ?? undefined,
      after: updatedStream,
      before,
      correlationId: getCorrelationContext()?.correlation_id,
    });

    recordPrivilegedStreamAuditEvent({
      action: "stream.stop.override",
      after: updatedStream as unknown as Record<string, unknown>,
      before: before as unknown as Record<string, unknown>,
      metadata: { resultingStatus: updatedStream.status },
      request,
      streamId: id,
      targetAccount: updatedStream.recipient,
    });

    enqueueStreamLifecycleWebhook({
      action: "stop",
      after: updatedStream as unknown as Record<string, unknown>,
      before: before as unknown as Record<string, unknown>,
    });

    const payload = { data: updatedStream };
    if (token) {
      setIdempotency(db.idempotency, token, fingerprint, 200, payload);
    }

    logger.info("Stream stopped successfully", {
      streamId: id,
      action: "stop",
      status: "success",
    });

    return NextResponse.json(payload);
  });
}