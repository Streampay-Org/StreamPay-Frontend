"use client";

import { useCallback, useState } from "react";
import { EventTimeline, type ContractEvent } from "../../../components/EventTimeline";
import type { StreamHistoryEntry } from "@/app/lib/repositories/stream-history";

function toContractEvent(entry: StreamHistoryEntry): ContractEvent {
  return {
    id: entry.id,
    type: entry.type,
    summary: buildSummary(entry),
    timestamp: entry.at,
    txHash: entry.txHash,
    amount: entry.amountRaw,
  };
}

function buildSummary(entry: StreamHistoryEntry): string {
  switch (entry.type) {
    case "created":   return "Stream created";
    case "started":   return "Streaming activated; linear vesting began";
    case "paused":    return "Stream paused; accrual frozen";
    case "resumed":   return "Stream resumed; vesting continued";
    case "stopped":   return "Stream stopped by sender";
    case "settled":   return "Stream settled; funds released from escrow";
    case "withdrawn": return "Recipient withdrew vested funds";
    case "cancelled": return "Stream cancelled; escrow split between parties";
    default:          return `Event: ${entry.type}`;
  }
}

interface StreamEventsClientProps {
  streamId: string;
  initialEvents: ContractEvent[];
  initialNextCursor: string | null;
}

/**
 * Client wrapper that handles "Load more" pagination for the events page.
 *
 * The server component loads the first page; subsequent pages are fetched
 * client-side via GET /api/streams/:id/history.
 */
export function StreamEventsClient({
  streamId,
  initialEvents,
  initialNextCursor,
}: StreamEventsClientProps) {
  const [events, setEvents] = useState<ContractEvent[]>(initialEvents);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const url = `/api/streams/${streamId}/history?cursor=${encodeURIComponent(nextCursor)}&limit=20`;
      const res = await fetch(url, {
        headers: { "x-tenant-id": "default" },
      });
      if (!res.ok) {
        throw new Error(`Failed to load more events (HTTP ${res.status})`);
      }
      const json = (await res.json()) as {
        data: StreamHistoryEntry[];
        meta: { nextCursor: string | null };
      };
      setEvents((prev: ContractEvent[]) => [...prev, ...json.data.map(toContractEvent)]);
      setNextCursor(json.meta.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more events.");
    } finally {
      setLoading(false);
    }
  }, [streamId, nextCursor, loading]);

  return (
    <>
      {error && (
        <p role="alert" className="event-panel__error">
          {error}
        </p>
      )}
      <EventTimeline
        events={events}
        hasMore={nextCursor !== null}
        onLoadMore={handleLoadMore}
        loadingMore={loading}
      />
    </>
  );
}
