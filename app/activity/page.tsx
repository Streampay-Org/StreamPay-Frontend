"use client";

import React, { useState } from "react";
import { ActivityTimeline, StreamEvent } from "../components/ActivityTimeline";

const MOCK_EVENTS: StreamEvent[] = [
  {
    id: "evt-001",
    type: "created",
    streamId: "0x3a4f...c82e",
    streamName: "Payroll · Alice → Bob",
    timestamp: "2025-03-28T09:15:00Z",
    amount: "2,500.00",
    token: "USDC",
  },
  {
    id: "evt-002",
    type: "started",
    streamId: "0x3a4f...c82e",
    streamName: "Payroll · Alice → Bob",
    timestamp: "2025-03-28T09:16:42Z",
    amount: "2,500.00",
    token: "USDC",
  },
  {
    id: "evt-003",
    type: "created",
    streamId: "0xf10b...77d1",
    streamName: "Grant · DAO → Dev Fund",
    timestamp: "2025-03-29T14:03:10Z",
    amount: "10,000.00",
    token: "STRM",
  },
  {
    id: "evt-004",
    type: "settled",
    streamId: "0x3a4f...c82e",
    streamName: "Payroll · Alice → Bob",
    timestamp: "2025-03-30T00:00:00Z",
    amount: "2,500.00",
    token: "USDC",
  },
  {
    id: "evt-005",
    type: "stopped",
    streamId: "0xf10b...77d1",
    streamName: "Grant · DAO → Dev Fund",
    timestamp: "2025-03-30T08:45:22Z",
  },
];

type FilterType = "all" | "created" | "started" | "settled" | "stopped";

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "created", label: "Created" },
  { value: "started", label: "Started" },
  { value: "settled", label: "Settled" },
  { value: "stopped", label: "Stopped" },
];

export default function ActivityPage() {
  const [filter, setFilter] = useState<FilterType>("all");
  const [useMock, setUseMock] = useState(true);

  const source = useMock ? MOCK_EVENTS : [];
  const filtered =
    filter === "all" ? source : source.filter((e) => e.type === filter);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0d1117",
        color: "#f9fafb",
        fontFamily:
          "'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: "2rem 1rem",
      }}
    >
      <div style={{ maxWidth: "640px", margin: "0 auto" }}>

        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: "2rem",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: "1.375rem",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "#f9fafb",
              }}
            >
              Activity
            </h1>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "#6b7280" }}>
              Stream lifecycle events
            </p>
          </div>

          {/* demo toggle */}
          <button
            onClick={() => setUseMock((v) => !v)}
            style={{
              fontSize: "0.75rem",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "0.375rem",
              color: "#9ca3af",
              padding: "0.375rem 0.75rem",
              cursor: "pointer",
            }}
          >
            {useMock ? "Show empty state" : "Show mock events"}
          </button>
        </div>

        {/* filter tabs */}
        <div
          role="tablist"
          aria-label="Filter events"
          style={{
            display: "flex",
            gap: "0.25rem",
            marginBottom: "1.5rem",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: "0.5rem",
            padding: "0.25rem",
          }}
        >
          {FILTER_OPTIONS.map(({ value, label }) => {
            const active = filter === value;
            return (
              <button
                key={value}
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(value)}
                style={{
                  flex: 1,
                  fontSize: "0.8125rem",
                  fontWeight: active ? 500 : 400,
                  padding: "0.375rem 0.5rem",
                  borderRadius: "0.375rem",
                  border: "none",
                  background: active ? "rgba(255,255,255,0.1)" : "transparent",
                  color: active ? "#f9fafb" : "#6b7280",
                  cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* count badge */}
        {filtered.length > 0 && (
          <p
            style={{
              fontSize: "0.75rem",
              color: "#6b7280",
              margin: "0 0 1rem",
            }}
          >
            {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          </p>
        )}

        {/* timeline */}
        <ActivityTimeline events={filtered} />
      </div>
    </main>
  );
}
