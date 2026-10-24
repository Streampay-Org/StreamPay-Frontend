"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import type { StreamRowData } from "./StreamRow";
import { mockStreams } from "../streams/fixtures";

interface CommandPaletteComponentProps {
  streams: StreamRowData[];
}

const DynamicCommandPalette = dynamic<CommandPaletteComponentProps>(
  () => import("./CommandPalette").then((mod) => mod.CommandPalette),
  {
    ssr: false,
    loading: () => null,
  }
);

interface CachedData {
  streams: StreamRowData[];
  timestamp: number;
}

let inMemoryCache: CachedData | null = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

export function clearCommandPaletteCache() {
  inMemoryCache = null;
}

export function CommandPaletteLauncher() {
  const [isOpen, setIsOpen] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streams, setStreams] = useState<StreamRowData[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchStreams = useCallback(async () => {
    const isDemo =
      process.env.NEXT_PUBLIC_DEMO_MODE === "true" ||
      process.env.NODE_ENV === "development";

    const now = Date.now();
    if (inMemoryCache && now - inMemoryCache.timestamp < CACHE_TTL_MS) {
      setStreams(inMemoryCache.streams);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/streams?limit=50", {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch streams: ${res.statusText}`);
      }
      const json = await res.json();
      const rawList = Array.isArray(json.data) ? json.data : [];
      const mappedStreams: StreamRowData[] = rawList.map((item: any) => ({
        id: item.id,
        recipient: item.recipient || item.id,
        rate: item.rate || "",
        schedule: item.schedule || "",
        status: item.status || "active",
        nextAction: item.nextAction || "",
        tags: item.tags || [],
      }));

      inMemoryCache = {
        streams: mappedStreams,
        timestamp: Date.now(),
      };
      setStreams(mappedStreams);
    } catch (err: any) {
      if (err.name === "AbortError") {
        return;
      }
      if (isDemo) {
        setStreams(mockStreams);
      } else {
        setStreams([]);
      }
    }
  }, []);

  const trigger = useCallback(() => {
    setHasTriggered(true);
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        fetchStreams();
      }
      return next;
    });
  }, [fetchStreams]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
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
        {isOpen ? "Opening command palette" : ""}
      </div>
      {isLoading && (
        <div
          role="dialog"
          aria-label="Loading command palette"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "10vh",
            zIndex: 999,
          }}
        >
          <div
            style={{
              padding: "1.5rem",
              backgroundColor: "var(--panel-elevated, #1a1a1a)",
              borderRadius: "0.75rem",
              color: "var(--foreground, #fff)",
            }}
          >
            Loading…
          </div>
        </div>
      )}
      <DynamicCommandPalette streams={streams} />
    </>
  );
}
