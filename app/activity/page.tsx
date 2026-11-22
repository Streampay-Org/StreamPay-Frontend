"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { StateTriad } from "../components/StateTriad";
import {
  ActivityTimeline,
  ActivityTimelineSkeleton,
  type ActivityEvent,
  type ActivityGroup,
} from "../components/ActivityTimeline";
import type { StateTriadState } from "../components/StateTriad";
import { LiveRegion } from "../components/LiveRegion";
import {
  DEFAULT_TIME_ZONE,
  getDisplayTimeZone,
  subscribeToDisplayTimeZone,
} from "../lib/timezone";

type ActivityPageState = "loading" | "populated" | "empty" | "error";

type RawActivityEvent = {
  id: string;
  type: string;
  description?: string;
  timestamp: string;
  streamId?: string;
  isDeleted?: boolean;
};

const STATUS_BY_TYPE: Record<string, ActivityEvent["status"]> = {
  stream_created: "accent",
  wallet_connected: "success",
  funds_withdrawn: "warning",
  stream_settled: "info",
};

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

function shiftDayKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

function formatDayLabel(date: Date, timeZone: string, now: Date): string {
  const key = dayKey(date, timeZone);
  const todayKey = dayKey(now, timeZone);

  if (key === todayKey) return "Today";
  if (key === shiftDayKey(todayKey, -1)) return "Yesterday";

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(date);
}

function groupActivityEvents(
  events: RawActivityEvent[],
  timeZone: string,
  now: Date
): ActivityGroup[] {
  const groups = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    const date = new Date(event.timestamp);
    const label = Number.isNaN(date.getTime())
      ? "Unknown"
      : formatDayLabel(date, timeZone, now);
    const type = event.type.replace(".", "_");

    const uiEvent: ActivityEvent = {
      id: event.id,
      type: type as ActivityEvent["type"],
      title: event.description || type,
      timestamp: event.timestamp,
      link:
        event.streamId && !event.isDeleted
          ? `/streams/${event.streamId}`
          : undefined,
      status: STATUS_BY_TYPE[type] ?? "info",
    };

    const bucket = groups.get(label);
    if (bucket) {
      bucket.push(uiEvent);
    } else {
      groups.set(label, [uiEvent]);
    }
  }

  return Array.from(groups, ([date, groupEvents]) => ({
    date,
    events: groupEvents,
  }));
}

export default function ActivityPage() {
  const [pageState, setPageState] = useState<ActivityPageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [activityEvents, setActivityEvents] = useState<RawActivityEvent[]>([]);
  const [timeZone, setTimeZone] = useState<string>(DEFAULT_TIME_ZONE);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    setTimeZone(getDisplayTimeZone());
    return subscribeToDisplayTimeZone(setTimeZone);
  }, []);

  const activities = useMemo(
    () => groupActivityEvents(activityEvents, timeZone, new Date()),
    [activityEvents, timeZone]
  );

  const handleRetry = useCallback(() => {
    setLoadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    setPageState("loading");

    async function fetchActivity() {
      try {
        const res = await fetch("/api/activity?limit=50", {
          headers: {
            "x-tenant-id": "default-tenant", // Assuming a tenant or passing whatever is available
          }
        });
        if (!res.ok) throw new Error("Failed to fetch");
        const body = await res.json();
        
        if (!mounted) return;

        const events: RawActivityEvent[] = Array.isArray(body.data) ? body.data : [];

        setActivityEvents(events);
        setPageState(events.length > 0 ? "populated" : "empty");
      } catch (err: unknown) {
        if (mounted) {
          setPageState("error");
          setErrorMessage(err instanceof Error && err.message ? err.message : "Couldn't load your activity");
        }
      }
    }
    
    void fetchActivity();

    return () => { mounted = false; };
  }, [loadKey]);

  // Map to StateTriad state
  const getTriadState = (): StateTriadState => {
    if (pageState === "loading") return "loading";
    if (pageState === "error") return "error";
    if (pageState === "empty" || activities.length === 0) return "empty";
    return "success";
  };

  const totalEvents = activities.reduce((sum, g) => sum + g.events.length, 0);

  let announcement = "";
  let politeness: "polite" | "assertive" = "polite";

  if (pageState === "loading") {
    announcement = "Loading activity…";
    politeness = "polite";
  } else if (pageState === "error") {
    announcement = errorMessage || "Couldn't load your activity";
    politeness = "assertive";
  } else if (pageState === "empty" || totalEvents === 0) {
    announcement = "No activity to display.";
    politeness = "polite";
  } else {
    announcement = `Loaded ${totalEvents} event${totalEvents === 1 ? "" : "s"}`;
    politeness = "polite";
  }

  return (
    <main className="page-shell">
      <LiveRegion
        message={announcement}
        politeness={politeness}
        data-testid="activity-live-region"
      />

      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">Activity</p>
          <h1 className="page-hero__title">Track every event.</h1>
          <p className="page-hero__description">
            Every transaction, status update, and wallet event — visible the
            moment it happens.
          </p>
        </div>
      </section>

      <section
        aria-busy={pageState === "loading"}
        aria-labelledby="activity-overview-title"
        className="stream-layout"
      >
        <div className="section-heading">
          <div>
            <h2
              className="section-heading__title"
              id="activity-overview-title"
            >
              Activity feed
            </h2>
            <p className="section-heading__description">
              Payments, stream lifecycle changes, and wallet events appear here
              as they happen.
            </p>
          </div>
        </div>

        <StateTriad
          state={getTriadState()}
          loading={{
            renderSkeleton: () => <ActivityTimelineSkeleton />,
          }}
          empty={{
            eyebrow: "Activity",
            title: "Activity will appear here",
            description:
              "Any payment stream updates, payments, or wallet events will show up once activity begins. Stay connected to monitor your flow.",
            actionLabel: "View Streams",
            onAction: () => {
              window.location.href = "/streams";
            },
          }}
          error={{
            heading: "Couldn't load your activity",
            message:
              "There was a problem fetching your activity feed. Check your connection and try again.",
            onRetry: handleRetry,
          }}
        >
          <ActivityTimeline groups={activities} />
        </StateTriad>
      </section>
    </main>
  );
}
