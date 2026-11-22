"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { isTextEntry } from "../../lib/keyboard";
import { LazyDialogShell } from "./LazyDialogShell";

const LazyOverlay = dynamic(() => import("./ShortcutsOverlayOpen"), {
  ssr: false,
  loading: () => <LazyDialogShell label="Loading…" />,
});

/** Registers the question-mark key and loads the overlay on first trigger only. */
export function ShortcutsOverlayLauncher() {
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (requested) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        setRequested(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requested]);

  return requested ? <LazyOverlay /> : null;
}
