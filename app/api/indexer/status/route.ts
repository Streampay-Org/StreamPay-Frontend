/**
 * GET /api/indexer/status
 *
 * SSE endpoint that streams live indexer status updates.
 * Emits an "indexer_status" event every 5 seconds with ledger cursor,
 * ingestion lag, queue depth, and — most importantly — a deterministic
 * `status` value derived from the pure state machine in `lib/indexerStatus.ts`
 * (loading / syncing / synced / stalled / stopped / error / retrying).
 *
 * The reported status is **deterministic**: it is a pure function of the real
 * cursor state, the operator-controlled circuit breaker, and the current time.
 * Staleness is the explicit `stale` flag so dashboards and operators can
 * distinguish a healthy-but-catching-up indexer from one whose cursor has
 * silently stopped advancing.
 *
 * Clients should use EventSource:
 *   const es = new EventSource('/api/indexer/status');
 *   es.addEventListener('indexer_status', (e) => console.log(JSON.parse(e.data)));
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { withRouteSpan } from "@/lib/routeSpan";
import { applyRateLimit } from "@/src/middleware/rateLimit";
import { getIndexerStatus } from "./status";

async function handleIndexerStatusGet(request: Request) {
  const rateLimited = await applyRateLimit(request, "indexer/status", "GET");
  if (rateLimited) return rateLimited;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Send initial status immediately.
      send("indexer_status", getIndexerStatus());

      // Then send updates every 5 seconds for up to 30 seconds.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          send("indexer_status", getIndexerStatus());
        } catch {
          break;
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request) {
  return withRouteSpan("/api/indexer/status", () => handleIndexerStatusGet(request));
}
