import { NextRequest, NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  getStore,
  idempotencyToken,
  setIdempotency,
  withLock,
} from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { enforceStreamRbac } from "@/app/lib/org-policy";
import { resolveRequestId } from "@/lib/requestId";

const MAX_BATCH_SIZE = 20;

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

/**
 * POST /api/streams/batch/start
 *
 * Batch starts or resumes streams.
 *
 * Actor resolution order:
 * 1. Verified JWT `sub` claim (Bearer token).
 * 2. `Actor-Wallet-Address` header (fallback only when STREAMPAY_ALLOW_ACTOR_HEADER=true).
 * If both are present and differ, returns 403 ACTOR_MISMATCH.
 *
 * RBAC ordering:
 * Evaluated per stream ID in the dry-run validation phase, immediately after
 * 404 existence checks and before state transitions. Fails all-or-nothing
 * with 422 VALIDATION_ERROR detailing the failing stream index.
 */
export async function POST(request: NextRequest) {
  const { idempotencyStore, streamRepository } = getStore();
  const idempotencyKey = getHeader(request, "Idempotency-Key");
  const token = idempotencyKey ? idempotencyToken("streams.batch.start", idempotencyKey) : null;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON.", request_id: getCorrelationContext()?.request_id } }, { status: 400 });
  }

  if (!Array.isArray(body)) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Request body must be a JSON array of stream ids.", request_id: getCorrelationContext()?.request_id } }, { status: 400 });
  }

  if (body.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: { code: "BATCH_LIMIT_EXCEEDED", message: `Batch limit exceeded. Maximum ${MAX_BATCH_SIZE} streams per request.`, request_id: getCorrelationContext()?.request_id } }, { status: 400 });
  }

  const fingerprint = computeFingerprint("POST", "/api/streams/batch/start", body);
  if (token) {
    const cached = checkIdempotency(idempotencyStore, token, fingerprint);
    if (cached) {
      if (!cached.ok) {
        return NextResponse.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request.", request_id: getCorrelationContext()?.request_id } }, { status: 409 });
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  const ids = body as string[];

  // Acquire locks for unique ids in sorted order to avoid deadlocks
  const uniqueIds = Array.from(new Set(ids)).sort();

  async function acquireLocksAndExecute(index: number, action: () => Promise<NextResponse>) {
    if (index >= uniqueIds.length) return action();
    return withLock(uniqueIds[index], () => acquireLocksAndExecute(index + 1, action));
  }

  return acquireLocksAndExecute(0, async () => {
    const errors: Array<{ index: number; id: string; code: string; message: string }> = [];
    const toUpdate: string[] = [];

    const preExistingActive: any[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const stream = streamRepository.streams.get(id as string);
      if (!stream) {
        errors.push({ index: i, id, code: "STREAM_NOT_FOUND", message: `Stream '${id}' not found.` });
        continue;
      }

      // Dry-run RBAC check: runs after 404 and before any state check
      const rbacError = enforceStreamRbac(request, id, "start");
      if (rbacError) {
        const errData = (rbacError as any).errorDetail ?? (await rbacError.json()).error;
        errors.push({ index: i, id, code: errData.code, message: errData.message });
        continue;
      }

      // Treat already-active streams as idempotent no-ops and include them
      // in the response rather than failing the entire batch.
      if (stream.status === "active") {
        preExistingActive.push(stream);
        continue;
      }

      if (stream.status !== "draft" && stream.status !== "paused") {
        errors.push({ index: i, id, code: "INVALID_STREAM_STATE", message: `Cannot start stream '${id}' from status '${stream.status}'.` });
        continue;
      }

      toUpdate.push(id);
    }

    if (errors.length > 0) {
      logger.warn("Batch start validation failed", { batchSize: ids.length, errorCount: errors.length });
      const requestId = getCorrelationContext()?.request_id ?? resolveRequestId(request.headers);
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "One or more streams failed validation. No changes were applied.", details: errors, request_id: requestId } }, { status: 422 });
    }

    const updated: any[] = [...preExistingActive];
    const now = new Date().toISOString();

    for (const id of toUpdate) {
      const stream = streamRepository.streams.get(id)!;
      const isResume = stream.status === "paused";
      const before = structuredClone(stream);
      const updatedStream = {
        ...stream,
        nextAction: "pause",
        pausedAt: undefined,
        status: "active",
        updatedAt: now,
      } as any;
      streamRepository.streams.set(id, updatedStream);

      publishStreamChange({
        action: "start",
        actor: getHeader(request, "Actor-Wallet-Address") ?? undefined,
        after: updatedStream,
        before,
        correlationId: getCorrelationContext()?.correlation_id,
      });

      updated.push(updatedStream);
      logger.info(isResume ? "Stream resumed (batch)" : "Stream started (batch)", { streamId: id });
    }

    const payload = { data: updated };
    if (token) setIdempotency(idempotencyStore, token, fingerprint, 200, payload);

    return NextResponse.json(payload, { status: 200 });
  });
}
