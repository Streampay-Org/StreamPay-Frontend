"use client";

import { useCallback, useEffect, useState } from "react";
import type { Stream, StreamStatus } from "../types/openapi";
import { StreamsPageContent } from "./StreamsPageContent";
import type { StreamRowData } from "../components/StreamRow";

function toStreamRow(stream: Stream): StreamRowData {
  const actions: Record<StreamStatus, string> = {
    active: "Pause",
    draft: "Start",
    ended: "Withdraw",
    paused: "Start",
    cancelled: "Cancelled",
    withdrawn: "Settled",
  };

  return {
    id: stream.id,
    nextAction: actions[stream.status],
    rate: `${stream.rate} ${stream.token} / ${stream.schedule}`,
    recipient: stream.recipient,
    schedule: `Pays every ${stream.schedule}`,
    status: stream.status,
  };
}

export function StreamsDashboard() {
  const [state, setState] = useState<"loading" | "populated" | "empty" | "error">("loading");
  const [streams, setStreams] = useState<StreamRowData[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>();

  const loadStreams = useCallback(async () => {
    setState("loading");
    setErrorMessage(undefined);
    try {
      const response = await fetch("/api/streams?limit=100", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`The streams API returned ${response.status}.`);
      }

      const payload = (await response.json()) as { data?: Stream[] };
      if (!Array.isArray(payload.data)) {
        throw new Error("The streams API returned an invalid response.");
      }

      const rows = payload.data.map(toStreamRow);
      setStreams(rows);
      setState(rows.length > 0 ? "populated" : "empty");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load streams.",
      );
      setState("error");
    }
  }, []);

  useEffect(() => {
    void loadStreams();
  }, [loadStreams]);

  return (
    <StreamsPageContent
      state={state}
      streams={streams}
      errorMessage={errorMessage}
      onRetry={() => void loadStreams()}
      onRetryAction={() => window.location.assign("/streams/new")}
    />
  );
}
