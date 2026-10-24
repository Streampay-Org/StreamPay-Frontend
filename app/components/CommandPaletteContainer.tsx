"use client";

import { useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import type { StreamRowData } from "./StreamRow";
import { mockStreams } from "../streams/fixtures";

const CACHE_TTL_MS = 30_000;
let cache: { at: number; streams: StreamRowData[] } | null = null;


function fresh() {
  return cache !== null && Date.now() - cache.at < CACHE_TTL_MS;
}

function toRow(raw: Record<string, unknown>): StreamRowData {
  return {
    id: String(raw.id ?? ""),
    recipient: String(raw.recipient ?? ""),
    rate: String(raw.rate ?? ""),
    schedule: String(raw.schedule ?? ""),
    status: (raw.status ?? "draft") as StreamRowData["status"],
    nextAction: String(raw.nextAction ?? ""),
  };
}

/**
 * Loaded lazily on first open. Fetches the user's streams (cached briefly) and
 * falls back to the demo fixture, the same data the streams page renders by
 * default, if the request fails.
 */
export default function CommandPaletteContainer() {
  const [streams, setStreams] = useState<StreamRowData[]>(
    fresh() ? cache!.streams : [],
  );

  useEffect(() => {
    if (fresh()) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/streams?limit=50", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const rows = (Array.isArray(body?.data) ? body.data : []).map(toRow);
        cache = { at: Date.now(), streams: rows };
        setStreams(rows);
      } catch {
        if (!controller.signal.aborted) setStreams(mockStreams);
      }
    })();
    return () => controller.abort();
  }, []);

  return <CommandPalette streams={streams} defaultOpen />;
}
