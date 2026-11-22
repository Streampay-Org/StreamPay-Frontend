"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { LazyDialogShell } from "./LazyDialogShell";

const LazyPalette = dynamic(() => import("./CommandPaletteContainer"), {
  ssr: false,
  loading: () => <LazyDialogShell label="Loading…" />,
});

/** Registers Cmd/Ctrl+K and loads the palette on first trigger only. */
export function CommandPaletteLauncher() {
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (requested) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setRequested(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requested]);

  return requested ? <LazyPalette /> : null;
}
