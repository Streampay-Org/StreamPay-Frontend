"use client";

import { useState, useEffect, useCallback } from "react";
import { StateTriad } from "../components/StateTriad";
import {
  ActivityTimeline,
  ActivityTimelineSkeleton,
  type ActivityGroup,
} from "../components/ActivityTimeline";
import type { StateTriadState } from "../components/StateTriad";
import { LiveRegion } from "../components/LiveRegion";

type ActivityPageState = "loading" | "populated" | "empty" | "error";

export default function ActivityPage() {
  const [pageState, setPageState] = useState<ActivityPageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [activities, setActivities] = useState<ActivityGroup[]>([]);
  const [loadKey, setLoadKey] = useState(0);

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

        const events = body.data || [];
        
        // Group and map events
        const groupsMap: Record<string, any[]> = {};
        for (const event of events) {
          const d = new Date(event.timestamp);
          
          let dateStr = "Unknown";
          if (!isNaN(d.getTime())) {
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            
            if (d.toDateString() === today.toDateString()) {
              dateStr = "Today";
            } else if (d.toDateString() === yesterday.toDateString()) {
              dateStr = "Yesterday";
            } else {
              dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            }
          }
          
          let status = "info";
          const typeStr = event.type.replace('.', '_');
          if (typeStr === "stream_created") status = "accent";
          else if (typeStr === "wallet_connected") status = "success";
          else if (typeStr === "funds_withdrawn") status = "warning";
          else if (typeStr === "stream_settled") status = "info";
          
          const uiEvent = {
            id: event.id,
            type: typeStr as any,
            title: event.description || typeStr,
            timestamp: event.timestamp,
            link: event.streamId && !event.isDeleted ? `/streams/${event.streamId}` : undefined,
            status: status as any,
          };
      
          if (!groupsMap[dateStr]) {
            groupsMap[dateStr] = [];
          }
          groupsMap[dateStr].push(uiEvent);
        }

        const grouped = Object.keys(groupsMap).map(date => ({
          date,
          events: groupsMap[date],
        }));

        setActivities(grouped);
        setPageState(grouped.length > 0 ? "populated" : "empty");
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
