"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Installs the single `unhandledrejection` hook used by the client error
 * reporter. The component renders nothing and never blocks the tree.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      reportClientError({
        name: error.name,
        message: error.message,
        stack: error.stack,
        kind: "unhandled",
      });
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
    };
  }, []);

  return null;
}
