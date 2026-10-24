"use client";

import { ShortcutsOverlay } from "./ShortcutsOverlay";

/** Default export so next/dynamic can load the overlay already open. */
export default function ShortcutsOverlayOpen() {
  return <ShortcutsOverlay defaultOpen />;
}
