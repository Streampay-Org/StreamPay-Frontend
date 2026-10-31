import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  getStore,
  idempotencyToken,
  setIdempotency,
} from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { transition } from "@/app/lib/state-machine";
import type { StreamAction } from "@/app/types/openapi";
import { buildMultiGroupManifest, sortGroupLegs, type MultiGroupLeg } from "./group";

function errorResponse(code: string, message: string, status: number, details?: unknown) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

function withSortedLocks<T>(
  ids: string[],
  index: number,
  run: () => Promise<T>,
): Promise<T> {
  if (index >= ids.length) return run();
  const { streamRepository } = getStore();
  return streamRepository.withLock(ids[index], () => withSortedLocks(ids, index + 1, run));
}

export async function handleGroupAction(
  request: Request,
  groupId: string,
  action: Extract<StreamAction, "start" | "pause" | "stop">,
) {
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  const { idempotencyStore, streamRepository } = getStore();
  const requestPath = `/api/v2/streams/multi/${groupId}/${action}`;
  const key = request.headers.get("Idempotency-Key");
  const token = key ? idempotencyToken(`v2.multi.${groupId}.${action}`, key) : null;
  const fingerprint = computeFingerprint("POST", requestPath, null);

  const cachedResponse = () => {
    if (!token) return null;
    const cached = checkIdempotency(idempotencyStore, token, fingerprint);
    if (!cached) return null;
    if (!cached.ok) {
      return errorResponse(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key has been used with a different request.",
        409,
      );
    }
    return NextResponse.json(cached.body, { status: cached.status });
  };

  const cached = cachedResponse();
  if (cached) return cached;

  const groupIds = streamRepository.getMultiGroupStreamIds(groupId).sort();
  if (groupIds.length === 0) {
    return errorResponse("STREAM_GROUP_NOT_FOUND", `Stream group '${groupId}' not found.`, 404);
  }

  return withSortedLocks(groupIds, 0, async () => {
    const replay = cachedResponse();
    if (replay) return replay;

    const legs = groupIds
      .map((id) => streamRepository.streams.get(id))
      .filter((leg): leg is MultiGroupLeg => Boolean(leg && leg.multiGroupId === groupId));
    if (legs.length === 0) {
      return errorResponse("STREAM_GROUP_NOT_FOUND", `Stream group '${groupId}' not found.`, 404);
    }

    const actorAddress = request.headers.get("Actor-Wallet-Address")?.trim() || null;
    const failures: Array<{ id: string; status: string; code: string; message: string }> = [];
    const transitions = new Map<string, ReturnType<typeof transition>>();
    for (const leg of sortGroupLegs(legs)) {
      const result = transition(leg.status, action);
      transitions.set(leg.id, result);
      if (!result.ok) {
        failures.push({
          id: leg.id,
          status: leg.status,
          code: result.code,
          message: result.error,
        });
      }

      const policy = actorAddress ? checkStreamOrgPolicy(leg.id, actorAddress, action) : null;
      if (policy && !policy.allowed) {
        failures.push({
          id: leg.id,
          status: leg.status,
          code: policy.code,
          message: policy.message,
        });
      } else if (policy?.requiresApproval) {
        failures.push({
          id: leg.id,
          status: leg.status,
          code: "APPROVAL_REQUIRED",
          message: "This action requires multi-sig approval.",
        });
      }
    }

    if (failures.length > 0) {
      return errorResponse(
        "VALIDATION_ERROR",
        "One or more stream legs failed validation. No changes were applied.",
        422,
        failures,
      );
    }

    const now = new Date().toISOString();
    const updates: Array<{ before: MultiGroupLeg; after: MultiGroupLeg }> = [];
    for (const leg of sortGroupLegs(legs)) {
      const result = transitions.get(leg.id)!;
      if (!result.ok || result.nextStatus === leg.status) continue;

      const nextAction = result.nextStatus === "active"
        ? "pause"
        : result.nextStatus === "paused"
          ? "stop"
          : "withdraw";
      const after = {
        ...leg,
        nextAction,
        ...(action === "start" ? { pausedAt: undefined } : {}),
        ...(action === "pause" ? { pausedAt: now } : {}),
        status: result.nextStatus,
        updatedAt: now,
      } as MultiGroupLeg;
      updates.push({ before: leg, after });
    }

    for (const { after } of updates) {
      streamRepository.streams.set(after.id, after);
    }
    for (const { before, after } of updates) {
      const eventType = action === "start"
        ? before.status === "paused" ? "resumed" : "started"
        : action === "pause" ? "paused" : "stopped";
      appendStreamHistoryEvent({
        streamId: before.id,
        type: eventType,
        fromStatus: before.status,
        toStatus: after.status,
        at: now,
        actorWallet: actorAddress ?? undefined,
      });
      if (action === "pause" || action === "stop") {
        recordPrivilegedStreamAuditEvent({
          action: action === "pause" ? "stream.pause" : "stream.stop.override",
          after: after as unknown as Record<string, unknown>,
          before: before as unknown as Record<string, unknown>,
          ...(action === "stop" ? { metadata: { resultingStatus: after.status } } : {}),
          request,
          streamId: before.id,
          targetAccount: after.recipient,
        });
      }
    }

    const payload = buildMultiGroupManifest(groupId, updates.length > 0
      ? groupIds.map((id) => streamRepository.streams.get(id)).filter((leg): leg is MultiGroupLeg => Boolean(leg))
      : legs);
    if (token) setIdempotency(idempotencyStore, token, fingerprint, 200, payload);
    return NextResponse.json(payload);
  });
}