"use client";

import React, { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";

const DynamicShortcutsOverlay = dynamic(
  () => import("./ShortcutsOverlay").then((mod) => mod.ShortcutsOverlay),
  {
    ssr: false,
    loading: () => null,
  }
);

export function ShortcutsOverlayLauncher() {
  const [isOpen, setIsOpen] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const trigger = useCallback(() => {
    setHasTriggered(true);
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Don't trigger if user is typing in an input, textarea, or contentEditable element
      const target = event.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (event.key === "?" && !isInput) {
        event.preventDefault();
        trigger();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [trigger]);

  // If chunk loading takes > 300ms, show lightweight Loading... dialog shell
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isOpen) {
      timer = setTimeout(() => {
        setIsLoading(true);
      }, 300);
    } else {
      setIsLoading(false);
    }
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!hasTriggered && !isOpen) {
    return null;
  }

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
        }}
      >
        {isOpen ? "Opening keyboard shortcuts" : ""}
      </div>
      {isLoading && (
        <div
          role="dialog"
          aria-label="Loading shortcuts"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
          }}
        >
          <div
            style={{
              padding: "1.5rem",
              backgroundColor: "var(--card-surface, #1a1a1a)",
              borderRadius: "0.75rem",
              color: "var(--foreground, #fff)",
            }}
          >
            Loading…
          </div>
        </div>
      )}
      <DynamicShortcutsOverlay />
    </>
  );
}
