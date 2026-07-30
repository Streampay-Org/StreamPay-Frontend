"use client";

import { CommandPalette } from "./CommandPalette";
import { mockStreams } from "../streams/StreamsPageContent";

export function CommandPaletteWrapper() {
  return <CommandPalette streams={mockStreams} />;
}
