import Link from "next/link";
import { notFound } from "next/navigation";
import { StreamEventsClient } from "./StreamEventsClient";
import type { StreamHistoryEntry } from "@/app/lib/repositories/stream-history";
import type { ContractEvent } from "../../../components/EventTimeline";

/** Map a StreamHistoryEntry to the ContractEvent shape EventTimeline renders. */
function toContractEvent(entry: StreamHistoryEntry): ContractEvent {
  return {
    id: entry.id,
    type: entry.type,
    summary: buildSummary(entry),
    timestamp: entry.at,
    txHash: entry.txHash,     // optional until indexer is wired
    // ledger omitted until indexer is wired
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

type Props = { params: Promise<{ id: string }> };

export default async function StreamEventsPage({ params }: Props) {
  const { id } = await params;

  let initialEvents: ContractEvent[] = [];
  let initialNextCursor: string | null = null;
  let streamLabel = "Payment Stream";

  try {
    // Read the in-process store — no HTTP round-trip needed in server components.
    const { getStore } = await import("@/app/lib/db");
    const store = getStore();

    const rawStream = store.streamRepository.streams.get(id);
    if (!rawStream) {
      notFound();
      return null;
    }

    // Extract display label; the Stream type uses `recipient` as a display name.
    const s = rawStream as Record<string, unknown>;
    streamLabel = String(s.recipient ?? s.label ?? "Payment Stream");

    const { data, meta } = store.streamHistory.query({ streamId: id, limit: 20 });
    initialEvents = data.map(toContractEvent);
    initialNextCursor = meta.nextCursor;
  } catch {
    notFound();
    return null;
  }

  return (
    <main className="page-shell">
      <nav aria-label="Breadcrumb" className="no-print">
        <Link href={`/streams/${id}`} className="detail-back-link">
          ← Back to Stream
        </Link>
      </nav>

      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">Contract Events</p>
          <h1 className="page-hero__title detail-title">{streamLabel}</h1>
          <p className="page-hero__description">
            Audit the recent contract events for this stream and filter them by
            event type.
          </p>
        </div>
      </section>

      <div className="detail-card">
        <StreamEventsClient
          streamId={id}
          initialEvents={initialEvents}
          initialNextCursor={initialNextCursor}
        />
      </div>
    </main>
  );
}

export function generateMetadata() {
  return {
    title: "Contract Events — StreamPay",
    description: "Recent contract events for a payment stream, filterable by type.",
  };
}
