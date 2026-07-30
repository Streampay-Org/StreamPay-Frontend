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
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";

const MAX_BATCH_SIZE = 20;

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

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

      const actor = getHeader(request, "Actor-Wallet-Address");
      const policyResult = actor ? checkStreamOrgPolicy(id, actor, "start") : null;
      if (policyResult) {
        if (!policyResult.allowed) {
          errors.push({ index: i, id, code: policyResult.code, message: policyResult.message });
          continue;
        }
        if (policyResult.requiresApproval) {
          errors.push({ index: i, id, code: "APPROVAL_REQUIRED", message: "This action requires multi-sig approval." });
          continue;
        }
      }

      toUpdate.push(id);
    }

    if (errors.length > 0) {
      logger.warn("Batch start validation failed", { batchSize: ids.length, errorCount: errors.length });
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "One or more streams failed validation. No changes were applied.", details: errors, request_id: getCorrelationContext()?.request_id } }, { status: 422 });
    }

    const updated: any[] = [...preExistingActive];
    const now = new Date().toISOString();

    for (const id of toUpdate) {
      const stream = streamRepository.streams.get(id)!;
      const isResume = stream.status === "paused";
      const updatedStream = {
        ...stream,
        nextAction: "pause",
        pausedAt: undefined,
        status: "active",
        updatedAt: now,
      } as any;
      streamRepository.streams.set(id, updatedStream);
      updated.push(updatedStream);
      logger.info(isResume ? "Stream resumed (batch)" : "Stream started (batch)", { streamId: id });
    }

    const payload = { data: updated };
    if (token) setIdempotency(idempotencyStore, token, fingerprint, 200, payload);

    return NextResponse.json(payload, { status: 200 });
  });
}
