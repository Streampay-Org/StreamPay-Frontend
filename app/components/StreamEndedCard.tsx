"use client";

import React from "react";
import { Card } from "./Card";

interface StreamEndedCardProps {
  streamName?: string;
  amount?: string;
  currency?: string;
  endedAt?: Date;
  onDismiss?: () => void;
  onViewDetails?: () => void;
  className?: string;
}

export function StreamEndedCard({
  streamName = "Stream",
  amount,
  currency = "USDC",
  endedAt = new Date(),
  onDismiss,
  onViewDetails,
  className = "",
}: StreamEndedCardProps) {
  return (
    <Card className={`border-l-4 border-l-blue-500 bg-white dark:bg-gray-800 shadow-sm ${className}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Stream Ended
            </h3>
          </div>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            The stream <strong>{streamName}</strong> has successfully concluded.
          </p>
          {amount && (
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
              Total streamed: {amount} {currency}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Ended on {endedAt.toLocaleDateString()} at {endedAt.toLocaleTimeString()}
          </p>
          
          <div className="mt-4 flex gap-3">
            {onViewDetails && (
              <button
                onClick={onViewDetails}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded px-1"
                aria-label="View stream details"
              >
                View Details
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="text-sm font-medium text-gray-600 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded px-1"
                aria-label="Dismiss notification"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
