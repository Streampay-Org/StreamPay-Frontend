"use client";

import Link from "next/link";
import React from "react";
import { Timestamp } from "./Timestamp";
import { VirtualListItem } from "./VirtualListItem";

export type ActivityEvent = {
  id: string;
  type: "stream_created" | "stream_paused" | "stream_settled" | "funds_withdrawn" | "wallet_connected";
  title: string;
  timestamp: string;
  link?: string;
  status: "success" | "info" | "warning" | "accent";
};

export type ActivityGroup = {
  date: string;
  events: ActivityEvent[];
};

interface ActivityTimelineProps {
  groups: ActivityGroup[];
}

// Normalize ledger timestamps to UTC ISO to avoid timezone/clock-skew issues.
const INVALID_TIMESTAMP_FALLBACK = "";

function normalizeTimestamp(timestamp: string): string {
  if (typeof timestamp !== "string" || timestamp.trim() === "") {
    return INVALID_TIMESTAMP_FALLBACK;
  }
  const trimmed = timestamp.trim();
  const parsed = /^\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`[ActivityTimeline] Invalid timestamp: "${timestamp}"`);
    return INVALID_TIMESTAMP_FALLBACK;
  }
  return parsed.toISOString();
}

function normalizeActivityGroups(groups: ActivityGroup[]): ActivityGroup[] {
  return groups.map((group) => ({
    ...group,
    events: group.events.map((event) => ({
      ...event,
      timestamp: normalizeTimestamp(event.timestamp),
    })),
  }));
}

export const ActivityTimeline = ({ groups }: ActivityTimelineProps) => {
  const normalizedGroups = React.useMemo(() => normalizeActivityGroups(groups), [groups]);
  return (
    <div className="activity-feed-wrap">
      {normalizedGroups.map((group) => (
        <section key={group.date} className="activity-group">
          <h3 className="activity-group-title">{group.date}</h3>
          <ul className="activity-timeline">
            {group.events.map((event) => (
              <VirtualListItem key={event.id} className="activity-item" defaultHeight={100}>
                <div className="activity-marker">
                  <div className={`activity-dot activity-dot--${event.status}`} />
                  <div className="activity-line" />
                </div>
                <div className="activity-content">
                  <div className="activity-card">
                    <div className="activity-info">
                      <span className="activity-title">{event.title}</span>
                      {event.timestamp ? (
                        <Timestamp className="activity-time" iso={event.timestamp} />
                      ) : (
                        <span className="activity-time" title="Invalid timestamp">—</span>
                      )}
                    </div>
                    {event.link && (
                      <Link href={event.link} className="button button--secondary" style={{ minHeight: "2rem", padding: "0.4rem 0.8rem", fontSize: "0.8125rem" }}>
                        View
                      </Link>
                    )}
                  </div>
                </div>
              </VirtualListItem>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

export const ActivityTimelineSkeleton = () => {
  return (
    <div className="activity-feed-wrap" aria-hidden="true">
      {[1, 2].map((group) => (
        <div key={group} className="activity-group">
          <div className="skeleton" style={{ height: "0.75rem", width: "6rem", marginLeft: "2.5rem", marginBottom: "1rem" }} />
          <div className="activity-timeline">
            {[1, 2, 3].map((item) => (
              <div key={item} className="activity-item">
                <div className="activity-marker">
                  <div className="activity-dot" style={{ background: "var(--skeleton-base)" }} />
                  <div className="activity-line" style={{ background: "var(--skeleton-base)" }} />
                </div>
                <div className="activity-content">
                  <div className="activity-card" style={{ borderStyle: "dashed" }}>
                    <div className="activity-info">
                      <div className="skeleton" style={{ height: "1rem", width: "12rem", marginBottom: "0.5rem" }} />
                      <div className="skeleton" style={{ height: "0.75rem", width: "4rem" }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
