"use client";

import React from "react";
import type { StreamStatus } from "@/app/types/openapi";
import { StreamProgress } from "./StreamProgress";

export interface StreamData {
  id: string;
  status: StreamStatus;
  accruedAmount?: number;
  totalAmount?: number;
  startedAt?: string;
  endsAt?: string;
  name?: string;
}

export interface MergedStreamChartProps {
  streams: StreamData[];
  className?: string;
}

export function MergedStreamChart({ streams, className = "" }: MergedStreamChartProps) {
  if (!streams || streams.length === 0) {
    return <div className="merged-stream-chart empty" aria-live="polite">No streams available</div>;
  }

  const totalAccrued = streams.reduce((sum, s) => sum + (s.accruedAmount || 0), 0);
  const totalAmount = streams.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
  
  const allEnded = streams.every(s => s.status === "ended" || s.status === "withdrawn" || s.status === "cancelled");
  const anyActive = streams.some(s => s.status === "active");
  const anyPaused = streams.some(s => s.status === "paused");
  
  const aggregateStatus: StreamStatus = allEnded ? "ended" : (anyActive ? "active" : (anyPaused ? "paused" : "draft"));

  return (
    <div className={`merged-stream-chart ${className}`.trim()} role="region" aria-label="Merged Stream Visualization">
      <div className="merged-stream-chart__aggregate mb-8">
        <h3 className="merged-stream-chart__title text-lg font-semibold mb-2">Total Merged Progress</h3>
        <StreamProgress
          status={aggregateStatus}
          accruedAmount={totalAccrued}
          totalAmount={totalAmount}
        />
      </div>
      <div className="merged-stream-chart__breakdown space-y-4">
        <h4 className="merged-stream-chart__subtitle text-md font-medium text-gray-700 dark:text-gray-300">Breakdown by Stream</h4>
        <div className="merged-stream-chart__list flex flex-col gap-3">
          {streams.map(stream => (
            <div key={stream.id} className="merged-stream-chart__item">
              {stream.name && <div className="text-sm font-medium mb-1">{stream.name}</div>}
              <StreamProgress
                status={stream.status}
                accruedAmount={stream.accruedAmount}
                totalAmount={stream.totalAmount}
                startedAt={stream.startedAt}
                endsAt={stream.endsAt}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
