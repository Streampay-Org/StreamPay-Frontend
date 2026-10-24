"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

export function ClientErrorReporter() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportClientError({
        name: event.error?.name ?? "Error",
        message: event.message || event.error?.message || "Unknown error",
        stack: event.error?.stack,
        kind: "unhandled",
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      reportClientError({
        name: "UnhandledRejection",
        message:
          typeof event.reason === "string"
            ? event.reason
            : event.reason?.message ?? "Unhandled promise rejection",
        stack: event.reason?.stack,
        kind: "unhandled",
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  return null;
}
