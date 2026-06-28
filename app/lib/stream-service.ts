import { getStore } from "./db";
import { transition } from "./state-machine";
import { StreamAction, ApiError } from "@/app/types/openapi";

export type ServiceResult<T> = 
  | { ok: true; data: T }
  | { ok: false; error: ApiError; status: number };

export class StreamService {
  static async applyAction(streamId: string, action: StreamAction, idempotencyKey?: string): Promise<ServiceResult<any>> {
    const { idempotencyStore, streamRepository } = getStore();
    const stream = streamRepository.streams.get(streamId);
    if (!stream) {
      return { 
        ok: false, 
        error: { code: "STREAM_NOT_FOUND", message: `Stream '${streamId}' not found`, request_id: "mock-id" },
        status: 404 
      };
    }

    // Idempotency check (simplified for mock)
    if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
      return { ok: true, data: idempotencyStore.get(idempotencyKey) };
    }

    const result = transition(stream.status, action);
    if (!result.ok) {
      return { 
        ok: false, 
        error: { code: result.code, message: result.error, request_id: "mock-id" },
        status: 409 
      };
    }

    // Update stream state
    stream.status = result.nextStatus;
    stream.updatedAt = new Date().toISOString();
    
    // Update nextAction hint for UI
    if (stream.status === "active") stream.nextAction = "pause";
    if (stream.status === "paused") stream.nextAction = "start";
    if (stream.status === "ended") stream.nextAction = "withdraw";
    if (stream.status === "withdrawn") stream.nextAction = undefined;

    streamRepository.streams.set(streamId, stream);

    if (idempotencyKey) {
      idempotencyStore.set(idempotencyKey, stream);
    }

    // Durably record the event in the transactional outbox in the same step as
    // the state change above, so it survives a crash and is delivered
    // at-least-once by the outbox worker. The id is derived from the stream and
    // its new updatedAt timestamp so a retried action does not enqueue a
    // duplicate. The inline emit below remains for low-latency live (SSE)
    // subscribers; the outbox is the durable safety net.
    const settled = (stream.status as string) === "settled" || stream.status === "ended";
    const { eventBus } = require("./event-bus");
    eventBus.enqueueStreamUpdated(streamId, stream, {
      id: `stream.updated:${streamId}:${stream.updatedAt}`,
    });
    if (settled) {
      eventBus.enqueueSettleFinished(streamId, stream, {
        id: `settle.finished:${streamId}:${stream.updatedAt}`,
      });
    }

    // Emit inline for real-time updates (best-effort, low latency).
    eventBus.emitStreamUpdated(streamId, stream);
    if (settled) {
      eventBus.emitSettleFinished(streamId, stream);
    }



    return { ok: true, data: stream };
  }
}
