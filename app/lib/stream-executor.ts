/**
 * Stream Action Executor
 *
 * Authoritative executor for stream lifecycle transitions (start, pause, stop, settle, withdraw).
 * Shared by both direct API lifecycle routes and the asynchronous approval execution route.
 */

import { db } from "@/app/lib/db";
import { transition } from "@/app/lib/state-machine";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { getStellarSettlementClient } from "@/app/lib/stellar";
import { evaluateWithdrawalState } from "@/app/lib/withdraw-finality";
import { maybeFeeBump } from "@/lib/feeBump";
import { logger, getCorrelationContext } from "@/app/lib/logger";
import type { Stream, StreamAction } from "@/app/types/openapi";

export type StreamExecutionAction = StreamAction | "resume";

export interface ExecuteStreamActionOptions {
  actor?: string | null;
  approvalId?: string;
  request?: Request;
  customFetch?: typeof fetch;
}

export type ExecuteStreamActionResult =
  | {
      ok: true;
      status: number;
      stream: Stream;
      data: any;
      extra?: Record<string, any>;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    };

export async function executeStreamAction(
  streamId: string,
  action: StreamExecutionAction,
  options: ExecuteStreamActionOptions = {},
): Promise<ExecuteStreamActionResult> {
  const stream = db.streams.get(streamId);
  if (!stream) {
    return {
      ok: false,
      status: 404,
      code: "STREAM_NOT_FOUND",
      error: `Stream '${streamId}' not found`,
    };
  }

  // Validate known actions
  const validActions = ["start", "pause", "resume", "stop", "settle", "withdraw"];
  if (!validActions.includes(action)) {
    return {
      ok: false,
      status: 400,
      code: "UNKNOWN_ACTION",
      error: `Unknown action '${action}'`,
    };
  }

  // Map "resume" to canonical state-machine action "start"
  const canonicalAction: StreamAction = action === "resume" ? "start" : (action as StreamAction);

  // Specific state guards matching existing route contracts
  if (canonicalAction === "pause") {
    if (stream.status !== "active") {
      return {
        ok: false,
        status: 409,
        code: "INVALID_STREAM_STATE",
        error: `Cannot pause a stream in '${stream.status}' status. Stream must be active.`,
      };
    }
  } else if (canonicalAction === "start") {
    if (stream.status !== "draft" && stream.status !== "paused") {
      return {
        ok: false,
        status: 409,
        code: "INVALID_STREAM_STATE",
        error: `Cannot start a stream in '${stream.status}' status. Stream must be draft or paused.`,
      };
    }
  } else if (canonicalAction === "stop") {
    if (stream.status !== "active" && stream.status !== "draft") {
      return {
        ok: false,
        status: 409,
        code: "INVALID_STREAM_STATE",
        error: "Only active or draft streams can be stopped",
      };
    }
  } else if (canonicalAction === "settle") {
    if (stream.status !== "active" && stream.status !== "paused") {
      return {
        ok: false,
        status: 409,
        code: "INVALID_STREAM_STATE",
        error: "Only active or paused streams can be settled",
      };
    }
  } else if (canonicalAction === "withdraw") {
    if (stream.status !== "ended") {
      if (stream.status === "withdrawn") {
        return {
          ok: true,
          status: 200,
          stream,
          data: stream,
          extra: { withdrawal: stream.withdrawal },
        };
      }
      return {
        ok: false,
        status: 409,
        code: "INVALID_STREAM_STATE",
        error: "Only ended streams can be withdrawn from",
      };
    }
  }

  // Validate state transition using state-machine helper
  const transitionResult = transition(stream.status, canonicalAction);
  if (!transitionResult.ok) {
    return {
      ok: false,
      status: 409,
      code: "INVALID_STREAM_STATE",
      error: transitionResult.error,
    };
  }

  const before = structuredClone(stream);
  const now = new Date().toISOString();
  const nextStatus = transitionResult.nextStatus;

  // Base metadata for audit logging
  const metadata: Record<string, any> = {};
  if (options.approvalId) {
    metadata.approvalId = options.approvalId;
  }

  const effectiveFetch = options.customFetch ?? (typeof fetch !== "undefined" ? fetch : undefined);

  if (canonicalAction === "start") {
    const isResume = stream.status === "paused";
    const updatedStream: Stream = {
      ...stream,
      nextAction: "pause" as const,
      pausedAt: undefined,
      status: "active" as const,
      updatedAt: now,
    };
    db.streams.set(streamId, updatedStream);

    logger.info(isResume ? "Stream resumed successfully" : "Stream started successfully", {
      streamId,
      action: isResume ? "resume" : "start",
      status: "success",
    });

    return {
      ok: true,
      status: 200,
      stream: updatedStream,
      data: updatedStream,
    };
  }

  if (canonicalAction === "pause") {
    const updatedStream: Stream = {
      ...stream,
      pausedAt: now,
      nextAction: "stop" as const,
      status: "paused" as const,
      updatedAt: now,
    };
    db.streams.set(streamId, updatedStream);

    recordPrivilegedStreamAuditEvent({
      action: "stream.pause",
      after: updatedStream as any,
      before: before as any,
      metadata,
      request: options.request ?? (new Request(`http://localhost/api/streams/${streamId}/pause`, {
        headers: {
          ...(options.actor ? { "Actor-Wallet-Address": options.actor } : {}),
          ...(getCorrelationContext()?.request_id ? { "x-request-id": getCorrelationContext()!.request_id } : {}),
        },
      }) as any),
      streamId,
      targetAccount: updatedStream.recipient,
    });

    logger.info("Stream paused successfully", {
      action: "pause",
      pausedAt: now,
      status: "success",
      streamId,
    });

    return {
      ok: true,
      status: 200,
      stream: updatedStream,
      data: updatedStream,
    };
  }

  if (canonicalAction === "stop") {
    const updatedStream: Stream = {
      ...stream,
      nextAction: "withdraw" as const,
      status: "ended" as const,
      updatedAt: now,
    };
    db.streams.set(streamId, updatedStream);

    metadata.resultingStatus = updatedStream.status;

    recordPrivilegedStreamAuditEvent({
      action: "stream.stop.override",
      after: updatedStream as unknown as Record<string, unknown>,
      before: before as unknown as Record<string, unknown>,
      metadata,
      request: options.request ?? (new Request(`http://localhost/api/streams/${streamId}/stop`, {
        headers: {
          ...(options.actor ? { "Actor-Wallet-Address": options.actor } : {}),
          ...(getCorrelationContext()?.request_id ? { "x-request-id": getCorrelationContext()!.request_id } : {}),
        },
      }) as any),
      streamId,
      targetAccount: updatedStream.recipient,
    });

    logger.info("Stream stopped successfully", {
      streamId,
      action: "stop",
      status: "success",
    });

    return {
      ok: true,
      status: 200,
      stream: updatedStream,
      data: updatedStream,
    };
  }

  if (canonicalAction === "settle") {
    const txHash = `fake-tx-${crypto.randomUUID().slice(0, 8)}`;
    const updatedStream: Stream = {
      ...stream,
      nextAction: "withdraw" as const,
      settlementTxHash: txHash,
      status: "ended" as const,
      updatedAt: now,
      withdrawal: {
        attempts: 0,
        lastCheckedAt: now,
        requestedAt: now,
        settlementTxHash: txHash,
        state: "pending" as const,
      },
    };

    try {
      const settlement = await getStellarSettlementClient().settleStream({ streamId });

      db.streams.set(streamId, updatedStream);

      metadata.settlementTxHash = settlement.txHash;

      recordPrivilegedStreamAuditEvent({
        action: "stream.settle",
        after: updatedStream as any,
        before: before as any,
        metadata,
        request: options.request ?? (new Request(`http://localhost/api/streams/${streamId}/settle`, {
          headers: {
            ...(options.actor ? { "Actor-Wallet-Address": options.actor } : {}),
            ...(getCorrelationContext()?.request_id ? { "x-request-id": getCorrelationContext()!.request_id } : {}),
          },
        }) as any),
        streamId,
        targetAccount: updatedStream.recipient,
      });

      logger.info("Stream settled successfully", {
        streamId,
        action: "settle",
        status: "success",
      });

      return {
        ok: true,
        status: 200,
        stream: updatedStream,
        data: { ...updatedStream, settlement },
      };
    } catch {
      // Settlement failed on Stellar/Soroban — keep stream state unchanged (atomic)
      return {
        ok: false,
        status: 502,
        code: "SETTLEMENT_FAILED",
        error: "Failed to settle stream on Stellar/Soroban",
      };
    }
  }

  if (canonicalAction === "withdraw") {
    let evaluationResult = await evaluateWithdrawalState(stream, new Date(), effectiveFetch);

    const { result: finalResult, feeBump } = await maybeFeeBump(
      { stream: evaluationResult.stream, alert: evaluationResult.alert },
      effectiveFetch,
    );

    if (feeBump.bumped) {
      logger.info("Fee-bump transaction submitted successfully", {
        streamId,
        newTxHash: feeBump.newTxHash,
      });
    } else if (feeBump.error) {
      logger.warn("Fee-bump attempt failed", {
        streamId,
        error: feeBump.error,
      });
    }

    const updated = finalResult.stream;
    db.streams.set(streamId, updated);

    metadata.resultingStatus = updated.status;
    metadata.withdrawalState = updated.withdrawal?.state ?? null;

    recordPrivilegedStreamAuditEvent({
      action: "stream.withdraw",
      after: updated as any,
      before: before as any,
      metadata,
      request: options.request ?? (new Request(`http://localhost/api/streams/${streamId}/withdraw`, {
        headers: {
          ...(options.actor ? { "Actor-Wallet-Address": options.actor } : {}),
          ...(getCorrelationContext()?.request_id ? { "x-request-id": getCorrelationContext()!.request_id } : {}),
        },
      }) as any),
      streamId,
      targetAccount: updated.recipient,
    });

    logger.info("Stream withdrawn successfully", {
      streamId,
      action: "withdraw",
      status: "success",
    });

    return {
      ok: true,
      status: 200,
      stream: updated,
      data: updated,
      extra: {
        alert: finalResult.alert,
        withdrawal: updated.withdrawal,
        ...(feeBump.bumped ? { feeBump: { bumped: true, newTxHash: feeBump.newTxHash } } : {}),
      },
    };
  }

  return {
    ok: false,
    status: 400,
    code: "UNKNOWN_ACTION",
    error: `Unknown action '${action}'`,
  };
}
