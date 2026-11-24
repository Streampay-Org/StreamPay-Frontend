"use client";

import { ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { PageError } from "./PageError";
import { Skeleton } from "./Skeleton";

export type StateTriadState = "loading" | "empty" | "error" | "success";

export interface StateTriadProps {
  /** Current state of the data */
  state: StateTriadState;
  
  /** Configuration for loading state */
  loading?: {
    /** Message to display while loading */
    message?: string;
    /** Number of skeleton items to show */
    count?: number;
    /** Custom skeleton renderer */
    renderSkeleton?: () => ReactNode;
  };
  
  /** Configuration for empty state */
  empty?: {
    eyebrow?: string;
    title?: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
    guidanceSteps?: string[];
  };
  
  /** Configuration for error state */
  error?: {
    heading?: string;
    message?: string;
    onRetry?: () => void;
  };
  
  /** Content to render when state is 'success' */
  children: ReactNode;
  
  /** Additional CSS classes */
  className?: string;
}

/**
 * Unified StateTriad Component
 * 
 * Provides consistent loading, empty, and error states across the application.
 * Follows design system patterns and ensures accessibility compliance.
 */
export function StateTriad({
  state,
  loading = { count: 3 },
  empty = {},
  error = {},
  children,
  className = "",
}: StateTriadProps) {
  // Loading state with skeleton
  if (state === "loading") {
    const renderDefaultSkeleton = () => (
      <div className="space-y-4" role="status" aria-live="polite">
        {loading.message && (
          <p className="text-gray-500 dark:text-gray-400 text-center text-sm">
            {loading.message}
          </p>
        )}
        <div className="space-y-3">
          {Array.from({ length: loading.count || 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center space-x-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg"
              style={{ animationDelay: `${i * 100}ms` }}
            >
              <div className="flex-1 space-y-2">
                <Skeleton height="1.125rem" width="60%" />
                <Skeleton height="0.875rem" width="40%" />
              </div>
              <Skeleton height="1.5rem" width="4.5rem" circle />
            </div>
          ))}
        </div>
      </div>
    );

    return (
      <div className={className}>
        {loading.renderSkeleton ? loading.renderSkeleton() : renderDefaultSkeleton()}
      </div>
    );
  }

  // Empty state
  if (state === "empty") {
    return (
      <div className={className}>
        <EmptyState
          eyebrow={empty.eyebrow || "No data yet"}
          title={empty.title || "Nothing to show here"}
          description={
            empty.description || "Get started by creating your first item"
          }
          actionLabel={empty.actionLabel || "Create one"}
          onAction={empty.onAction}
          guidanceSteps={empty.guidanceSteps}
        />
      </div>
    );
  }

  // Error state
  if (state === "error") {
    return (
      <div className={className}>
        <PageError
          heading={error.heading || "Couldn't load your data"}
          message={
            error.message ||
            "There was a problem fetching your data. Check your connection and try again."
          }
          onRetry={error.onRetry}
        />
      </div>
    );
  }

  // Success state - render children
  return <div className={className}>{children}</div>;
}
