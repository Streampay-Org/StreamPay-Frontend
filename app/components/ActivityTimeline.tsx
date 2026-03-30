"use client";

import React from "react";

export type StreamEventType = "created" | "started" | "settled" | "stopped";

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  streamId: string;
  streamName?: string;
  timestamp: string; // ISO string
  amount?: string;
  token?: string;
}

interface ActivityTimelineProps {
  events: StreamEvent[];
}

const EVENT_META: Record<
  StreamEventType,
  { label: string; color: string; dot: string; bg: string }
> = {
  created: {
    label: "Stream Created",
    color: "#60a5fa",
    dot: "#3b82f6",
    bg: "rgba(59,130,246,0.08)",
  },
  started: {
    label: "Stream Started",
    color: "#34d399",
    dot: "#10b981",
    bg: "rgba(16,185,129,0.08)",
  },
  settled: {
    label: "Stream Settled",
    color: "#a78bfa",
    dot: "#8b5cf6",
    bg: "rgba(139,92,246,0.08)",
  },
  stopped: {
    label: "Stream Stopped",
    color: "#f87171",
    dot: "#ef4444",
    bg: "rgba(239,68,68,0.08)",
  },
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EventIcon({ type }: { type: StreamEventType }) {
  const icons: Record<StreamEventType, JSX.Element> = {
    created: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 4v3l2 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
    started: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M4 3l7 4-7 4V3z" fill="currentColor" />
      </svg>
    ),
    settled: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M3 7l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    stopped: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      </svg>
    ),
  };
  return icons[type];
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  if (events.length === 0) {
    return (
      <div
        data-testid="activity-empty"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "4rem 2rem",
          gap: "0.75rem",
          opacity: 0.45,
        }}
      >
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="1" y="1" width="38" height="38" rx="10" stroke="#6b7280" strokeWidth="1.5" strokeDasharray="4 3" />
          <path d="M13 20h14M20 13v14" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <p style={{ margin: 0, fontSize: "0.875rem", color: "#9ca3af", letterSpacing: "0.02em" }}>
          No activity yet
        </p>
        <p style={{ margin: 0, fontSize: "0.75rem", color: "#6b7280" }}>
          Stream events will appear here
        </p>
      </div>
    );
  }

  return (
    <ol
      data-testid="activity-timeline"
      style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}
    >
      {/* vertical line */}
      <li
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "1.125rem",
          top: "1.5rem",
          bottom: "1.5rem",
          width: "1px",
          background: "linear-gradient(to bottom, transparent, #374151 10%, #374151 90%, transparent)",
          pointerEvents: "none",
        }}
      />

      {events.map((event, i) => {
        const meta = EVENT_META[event.type];
        return (
          <li
            key={event.id}
            data-testid={`event-item-${event.type}`}
            style={{
              display: "flex",
              gap: "1rem",
              padding: "0.25rem 0",
              marginBottom: i < events.length - 1 ? "0.25rem" : 0,
              position: "relative",
            }}
          >
            {/* dot */}
            <div
              style={{
                flexShrink: 0,
                width: "2.25rem",
                display: "flex",
                alignItems: "flex-start",
                paddingTop: "0.875rem",
                justifyContent: "center",
                zIndex: 1,
              }}
            >
              <span
                style={{
                  width: "2rem",
                  height: "2rem",
                  borderRadius: "50%",
                  background: meta.bg,
                  border: `1.5px solid ${meta.dot}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: meta.color,
                  flexShrink: 0,
                }}
              >
                <EventIcon type={event.type} />
              </span>
            </div>

            {/* card */}
            <div
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: "0.625rem",
                padding: "0.75rem 1rem",
                marginBottom: "0.5rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    color: meta.color,
                    letterSpacing: "0.03em",
                    textTransform: "uppercase",
                  }}
                >
                  {meta.label}
                </span>
                <time
                  dateTime={event.timestamp}
                  style={{ fontSize: "0.75rem", color: "#6b7280", flexShrink: 0 }}
                >
                  {formatTimestamp(event.timestamp)}
                </time>
              </div>

              <p
                style={{
                  margin: "0.25rem 0 0",
                  fontSize: "0.875rem",
                  color: "#d1d5db",
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                }}
              >
                {event.streamName ?? event.streamId}
              </p>

              {(event.amount || event.token) && (
                <p style={{ margin: "0.375rem 0 0", fontSize: "0.8125rem", color: "#9ca3af" }}>
                  {event.amount && (
                    <span style={{ color: "#e5e7eb", fontWeight: 500 }}>
                      {event.amount}
                    </span>
                  )}
                  {event.amount && event.token && " "}
                  {event.token && (
                    <span
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: "0.25rem",
                        padding: "0.1rem 0.375rem",
                        fontSize: "0.75rem",
                        color: "#9ca3af",
                      }}
                    >
                      {event.token}
                    </span>
                  )}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
