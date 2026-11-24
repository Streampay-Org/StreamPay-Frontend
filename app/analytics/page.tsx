"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ForecastChart } from "@/app/components/ForecastChart";
import { PageError } from "@/app/components/PageError";
import type { Stream } from "@/app/types/openapi";
import { formatBigInt } from "@/lib/format-bigint";
import { projectDailyFlows, type DailyFlow } from "./forecast";

type WalletResponse = { data?: { wallet_address?: string } };
type StreamsResponse = {
  data?: Stream[];
  meta?: { hasNext?: boolean; nextCursor?: string | null };
  error?: { message?: string };
};
type PageState = "loading" | "ready" | "disconnected" | "error";
type RangeDays = 7 | 30 | 90;

async function loadStreams(signal: AbortSignal): Promise<Stream[]> {
  const streams: Stream[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`/api/streams?${query}`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Could not load streams (status ${response.status}).`);
    }
    const body = (await response.json()) as StreamsResponse;
    if (!Array.isArray(body.data) || !body.meta) {
      throw new Error(body.error?.message ?? "The streams response was invalid.");
    }
    streams.push(...body.data);
    cursor = body.meta.hasNext ? body.meta.nextCursor ?? null : null;
    if (body.meta.hasNext && (!cursor || seenCursors.has(cursor))) {
      throw new Error("The streams response contained an invalid pagination cursor.");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return streams;
}

export default function AnalyticsPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [range, setRange] = useState<RangeDays>(30);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fromDate = useMemo(() => new Date(), []);

  const loadData = useCallback(async (signal: AbortSignal) => {
    setState("loading");
    setError(null);
    try {
      const identityResponse = await fetch("/api/identity/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (identityResponse.status === 401 || identityResponse.status === 403) {
        setWallet(null);
        setState("disconnected");
        return;
      }
      if (!identityResponse.ok) {
        throw new Error(`Could not verify the connected wallet (status ${identityResponse.status}).`);
      }
      const identity = (await identityResponse.json()) as WalletResponse;
      const walletAddress = identity.data?.wallet_address;
      if (typeof walletAddress !== "string" || walletAddress.length === 0) {
        setWallet(null);
        setState("disconnected");
        return;
      }

      const loadedStreams = await loadStreams(signal);
      if (!signal.aborted) {
        setWallet(walletAddress);
        setStreams(loadedStreams);
        setState("ready");
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Unable to load analytics.");
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData, reloadKey]);

  const forecast = useMemo(() => {
    if (state !== "ready" || !wallet) return { flows: [] as DailyFlow[], error: null };
    try {
      return {
        flows: projectDailyFlows(streams, wallet, fromDate, range),
        error: null,
      };
    } catch (cause) {
      return {
        flows: [] as DailyFlow[],
        error: cause instanceof Error ? cause.message : "Unable to calculate the forecast.",
      };
    }
  }, [fromDate, range, state, streams, wallet]);

  const totals = forecast.flows.reduce(
    (sum, flow) => ({
      incoming: sum.incoming + flow.incoming,
      outgoing: sum.outgoing + flow.outgoing,
    }),
    { incoming: 0n, outgoing: 0n },
  );
  const net = totals.incoming - totals.outgoing;
  const retry = () => setReloadKey((key) => key + 1);

  return (
    <main className="page-container" aria-labelledby="analytics-heading">
      <header className="page-header">
        <h1 id="analytics-heading">Cash-flow forecast</h1>
        <p className="page-subtitle">Projected incoming and outgoing stream flows by UTC day.</p>
      </header>

      {state === "loading" && (
        <p role="status" aria-label="Loading cash-flow forecast">Loading cash-flow forecast…</p>
      )}

      {state === "disconnected" && (
        <section className="card" aria-labelledby="wallet-disconnected-heading">
          <h2 id="wallet-disconnected-heading">Connect your wallet</h2>
          <p>Connect or sign in with a wallet to view your cash-flow forecast.</p>
        </section>
      )}

      {state === "error" && (
        <PageError
          heading="Could not load cash-flow forecast"
          message={error ?? "Unable to load analytics."}
          onRetry={retry}
        />
      )}

      {state === "ready" && forecast.error && (
        <div role="alert" className="card">
          <h2>Could not calculate cash-flow forecast</h2>
          <p>{forecast.error}</p>
        </div>
      )}

      {state === "ready" && !forecast.error && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <label htmlFor="forecast-range">
              Forecast range
              <select
                id="forecast-range"
                value={range}
                onChange={(event) => setRange(Number(event.target.value) as RangeDays)}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
          </div>

          <section aria-label="Forecast totals" className="dashboard-grid">
            <article className="card dashboard-tile">
              <h2 className="dashboard-tile__label">Incoming</h2>
              <p className="dashboard-tile__value" data-testid="forecast-incoming">
                {formatBigInt(totals.incoming)}
              </p>
            </article>
            <article className="card dashboard-tile">
              <h2 className="dashboard-tile__label">Outgoing</h2>
              <p className="dashboard-tile__value" data-testid="forecast-outgoing">
                {formatBigInt(totals.outgoing)}
              </p>
            </article>
            <article className="card dashboard-tile">
              <h2 className="dashboard-tile__label">Net</h2>
              <p className="dashboard-tile__value" data-testid="forecast-net">
                {formatBigInt(net)}
              </p>
            </article>
          </section>

          {streams.length === 0 ? (
            <section className="card" aria-label="No streams">
              <h2>No streams to forecast</h2>
              <p>Create a stream to see projected wallet cash flow.</p>
            </section>
          ) : (
            <>
              <ForecastChart flows={forecast.flows} />
              <section className="card" aria-labelledby="forecast-table-heading">
                <h2 id="forecast-table-heading">Per-day forecast</h2>
                <div className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">UTC date</th>
                        <th scope="col">Incoming</th>
                        <th scope="col">Outgoing</th>
                        <th scope="col">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecast.flows.map((flow) => (
                        <tr key={flow.date}>
                          <th scope="row">{flow.date}</th>
                          <td>{formatBigInt(flow.incoming)}</td>
                          <td>{formatBigInt(flow.outgoing)}</td>
                          <td>{formatBigInt(flow.incoming - flow.outgoing)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
