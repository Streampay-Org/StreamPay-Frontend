"use client";

import { useEffect } from "react";
import { useToast } from "../hooks/useToast";

export function ServiceWorkerRegistrar() {
  const toast = useToast();

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    let disposed = false;
    let notifiedWorker: ServiceWorker | null = null;

    const showUpdate = (worker: ServiceWorker) => {
      if (disposed || notifiedWorker === worker) return;
      notifiedWorker = worker;
      toast.toast({
        message: "Update available — reload",
        severity: "info",
        duration: 0,
        action: {
          label: "Reload",
          onClick: () => window.location.reload(),
        },
      });
    };

    const register = async () => {
      const buildId = process.env.NEXT_PUBLIC_BUILD_ID || "development";
      const registration = await navigator.serviceWorker.register(
        `/sw.js?build=${encodeURIComponent(buildId)}`,
        { scope: "/" }
      );

      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdate(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            showUpdate(worker);
          }
        });
      });
    };

    void register().catch((error: unknown) => {
      console.error("Service worker registration failed", error);
    });

    return () => {
      disposed = true;
    };
  }, [toast.toast]);

  return null;
}
