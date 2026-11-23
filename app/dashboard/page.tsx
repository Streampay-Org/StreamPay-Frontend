"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/app/components/EmptyState";
import { PageError } from "@/app/components/PageError";
import { Skeleton } from "@/app/components/Skeleton";
import type { StreamStats } from "@/app/lib/stream-stats";
import { formatBigInt } from "@/lib/format-bigint";

interface StatsApiResponse {
  data: StreamStats;
  links?: { self: string };
}

function formatTokenAmount(rawBaseUnits: string): string {
  try {
    return formatBigInt(BigInt(rawBaseUnits));
  } catch {
    return rawBaseUnits;
  }
}

function getTotalStreamCount(stats: StreamStats): number {
  return Object.values(stats.counts).reduce((acc, n) => acc + n, 0);
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/streams/stats", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const json = (await response.json()) as StatsApiResponse;
      if (!json?.data?.counts || !json?.data?.totals) {
        throw new Error("Invalid stats response format");
      }
      setStats(json.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load stream statistics. Please try again.",
      );
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStats(controller.signal);
    return () => controller.abort();
  }, [loadStats]);

  const tokenEntries = stats ? Object.entries(stats.totals) : [];
  const totalStreams = stats ? getTotalStreamCount(stats) : 0;

  return (
    <main className="page-container" aria-labelledby="dashboard-heading">
      <header className="page-header">
        <h1 id="dashboard-heading">Dashboard</h1>
        <p className="page-subtitle">Aggregate overview of your streams and escrowed balances.</p>
      </header>

      {loading && (
        <section
          aria-busy="true"
          aria-label="Loading stream statistics"
          data-testid="dashboard-skeleton"
          className="dashboard-grid"
        >
          <span className="sr-only">Loading dashboard statistics…</span>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="card dashboard-tile">
              <Skeleton variant="label" width="60%" />
              <Skeleton variant="value" width="40%" height="2rem" />
            </div>
          ))}
        </section>
      )}

      {!loading && error && (
        <PageError
          heading="Could not load dashboard"
          message={error}
          onRetry={() => {
            void loadStats();
          }}
        />
      )}

      {!loading && !error && stats && totalStreams === 0 && (
        <EmptyState
          eyebrow="No streams yet"
          title="Your dashboard is empty"
          description="Create your first payment stream to see active counts and escrowed totals here."
          actionLabel="Create stream"
          onAction={() => router.push("/streams/new")}
        />
      )}

      {!loading && !error && stats && totalStreams > 0 && (
        <section aria-label="Stream summary" className="dashboard-grid" data-testid="dashboard-stats">
          <article className="card dashboard-tile">
            <h2 className="dashboard-tile__label">Active</h2>
            <p className="dashboard-tile__value" data-testid="stat-active">
              {stats.counts.active}
            </p>
          </article>

          <article className="card dashboard-tile">
            <h2 className="dashboard-tile__label">Paused</h2>
            <p className="dashboard-tile__value" data-testid="stat-paused">
              {stats.counts.paused}
            </p>
          </article>

          <article className="card dashboard-tile">
            <h2 className="dashboard-tile__label">Ended</h2>
            <p className="dashboard-tile__value" data-testid="stat-ended">
              {stats.counts.ended}
            </p>
          </article>

          <article className="card dashboard-tile">
            <h2 className="dashboard-tile__label">Total Escrowed</h2>
            <div className="dashboard-tile__totals" data-testid="stat-escrowed">
              {tokenEntries.length === 0 ? (
                <p className="dashboard-tile__value">0</p>
              ) : (
                tokenEntries.map(([token, totals]) => (
                  <p key={token} className="dashboard-tile__value">
                    {formatTokenAmount(totals.escrowed)} {token}
                  </p>
                ))
              )}
            </div>
          </article>

          <article className="card dashboard-tile">
            <h2 className="dashboard-tile__label">Total Released</h2>
            <div className="dashboard-tile__totals" data-testid="stat-released">
              {tokenEntries.length === 0 ? (
                <p className="dashboard-tile__value">0</p>
              ) : (
                tokenEntries.map(([token, totals]) => (
                  <p key={token} className="dashboard-tile__value">
                    {formatTokenAmount(totals.released)} {token}
                  </p>
                ))
              )}
            </div>
          </article>
        </section>
      )}
    </main>
  );
}
