"use client";

import React, { useId, useMemo } from "react";

/**
 * StreamViz
 *
 * Multi-style visualisation for a stream's remaining funds over time.
 * Three variants are available:
 *
 * - **burn-down** — full SVG line chart showing the remaining-funds trajectory
 *   with a dashed accrued line and optional threshold guide.
 * - **sparkline** — compact inline SVG for row-level use (e.g. in stream lists).
 * - **data-table** — semantic HTML table fallback for screen-reader and
 *   non-visual contexts.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - Chart variants use `role="img"` with a descriptive `aria-label`.
 * - The `data-table` variant uses native `<table>` semantics.
 * - Colour is never the sole differentiator: lines pair colour with dash
 *   pattern, and a legend is included.
 * - Reduced-motion variant disables stroke-dashoffset animation.
 *
 * ## Design tokens
 * Uses the chart-sparkline-kit palette defined in CSS custom properties:
 * `--chart-accrual-line`, `--chart-remaining-line`, `--chart-threshold-line`.
 * Falls back to the design-spec hex values when the custom properties are
 * not set.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type StreamVizVariant = "burn-down" | "sparkline" | "data-table";

export interface StreamVizDataPoint {
  /** ISO-8601 date string for the data point. */
  date: string;
  /** Remaining funds at this point (display units). */
  remaining: number;
  /** Accrued funds at this point (display units). */
  accrued: number;
}

export interface StreamVizProps {
  /** Ordered data points (oldest first). */
  dataPoints: StreamVizDataPoint[];
  /** Visualisation style. Defaults to "burn-down". */
  variant?: StreamVizVariant;
  /** Label for the fund unit (e.g. "XLM"). Optional. */
  unit?: string;
  /** Optional CSS class forwarded to the wrapper. */
  className?: string;
  /** Show loading skeleton instead of chart. */
  loading?: boolean;
  /** Error message to display in place of the chart. */
  error?: string | null;
  /** Called when the user clicks the retry button in the error state. */
  onRetry?: () => void;
}

// ── Colour helpers ──────────────────────────────────────────────────────────

/**
 * Read a CSS custom property with a hex fallback.
 * Works in both light and dark themes via the cascade.
 */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Sub-components ──────────────────────────────────────────────────────────

/**
 * Legend row for the burn-down chart.
 * Pairs colour swatches with dash-pattern labels for accessibility.
 */
function ChartLegend({ unit = "XLM" }: { unit?: string }) {
  const remainingColor = cssVar("--chart-remaining-line", "#86EFAC");
  const accruedColor = cssVar("--chart-accrual-line", "#7DD3FC");

  return (
    <div className="stream-viz__legend" aria-hidden="true">
      <span className="stream-viz__legend-item">
        <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
          <line
            x1="0" y1="6" x2="20" y2="6"
            stroke={remainingColor}
            strokeWidth="2"
            strokeDasharray="6 4"
          />
        </svg>
        <span className="stream-viz__legend-label">Remaining ({unit})</span>
      </span>
      <span className="stream-viz__legend-item">
        <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
          <line
            x1="0" y1="6" x2="20" y2="6"
            stroke={accruedColor}
            strokeWidth="2"
          />
        </svg>
        <span className="stream-viz__legend-label">Accrued ({unit})</span>
      </span>
    </div>
  );
}

/**
 * Skeleton placeholder that matches chart dimensions to prevent layout shift.
 */
function ChartSkeleton({ width = 640, height = 280 }: { width?: number; height?: number }) {
  return (
    <div
      className="stream-viz__skeleton"
      style={{ width: "100%", maxWidth: width, height }}
      aria-hidden="true"
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        focusable="false"
        aria-hidden="true"
      >
        <rect
          x="0" y="0"
          width={width} height={height}
          fill="var(--skeleton-base)"
          rx="8"
        />
        <line
          x1="40" y1={height - 30}
          x2={width - 20} y2={height - 30}
          stroke="var(--skeleton-shine)"
          strokeWidth="1"
        />
        <path
          d={`M 40 ${height * 0.6} Q ${width * 0.3} ${height * 0.35} ${width - 20} ${height * 0.65}`}
          fill="none"
          stroke="var(--skeleton-shine)"
          strokeWidth="2"
          strokeDasharray="8 6"
        />
      </svg>
    </div>
  );
}

// ── Burn-down chart ─────────────────────────────────────────────────────────

/**
 * Full SVG line chart showing remaining funds over time, with an optional
 * accrued line. Designed per the chart-sparkline-kit spec:
 * - Max three series colours with dash patterns.
 * - Axes with minimal gridlines.
 * - Padding for axis labels.
 */
function BurnDownChart({ dataPoints, unit = "XLM" }: { dataPoints: StreamVizDataPoint[]; unit?: string }) {
  const gradientId = useId();

  const width = 640;
  const height = 280;
  const pad = { top: 24, right: 24, bottom: 40, left: 56 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const remainingColor = cssVar("--chart-remaining-line", "#86EFAC");
  const accruedColor = cssVar("--chart-accrual-line", "#7DD3FC");

  const values = useMemo(() => {
    const remaining = dataPoints.map((d) => d.remaining);
    const accrued = dataPoints.map((d) => d.accrued);
    const all = [...remaining, ...accrued];
    const maxVal = Math.max(...all, 1);
    const minVal = 0;
    const range = maxVal - minVal || 1;
    return { remaining, accrued, maxVal, minVal, range };
  }, [dataPoints]);

  const xScale = (i: number) =>
    pad.left + dataPoints.length > 1
      ? pad.left + (i / (dataPoints.length - 1)) * chartW
      : pad.left + chartW / 2;

  const yScale = (v: number) =>
    pad.top + chartH - ((v - values.minVal) / values.range) * chartH;

  const remainingPath = dataPoints
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(d.remaining)}`)
    .join(" ");

  const accruedPath = dataPoints
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(d.accrued)}`)
    .join(" ");

  const remainingArea = `${remainingPath} L ${xScale(dataPoints.length - 1)} ${yScale(0)} L ${xScale(0)} ${yScale(0)} Z`;
  const accruedArea = `${accruedPath} L ${xScale(dataPoints.length - 1)} ${yScale(0)} L ${xScale(0)} ${yScale(0)} Z`;

  const latestRemaining = dataPoints[dataPoints.length - 1]?.remaining ?? 0;
  const latestAccrued = dataPoints[dataPoints.length - 1]?.accrued ?? 0;

  // Axis labels: first, middle, last
  const axisLabels = dataPoints.length > 2
    ? [dataPoints[0], dataPoints[Math.floor(dataPoints.length / 2)], dataPoints[dataPoints.length - 1]]
    : dataPoints;

  const remainingPercent = values.maxVal > 0
    ? Math.round((latestRemaining / values.maxVal) * 100)
    : 0;

  return (
    <div className="stream-viz__chart-wrap">
      <div className="stream-viz__chart-header">
        <span className="stream-viz__chart-title">Remaining funds over time</span>
        <span className="stream-viz__chart-value">
          {formatAmount(latestRemaining)} {unit}
          <span className="stream-viz__chart-sub"> ({remainingPercent}% remaining)</span>
        </span>
      </div>

      <ChartLegend unit={unit} />

      <svg
        className="stream-viz__svg"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        focusable="false"
        aria-hidden="true"
        role="img"
        aria-label={`Chart showing remaining ${unit} over time. ${formatAmount(latestRemaining)} ${unit} remaining.`}
      >
        <defs>
          <linearGradient id={`${gradientId}-remaining`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={remainingColor} stopOpacity="0.2" />
            <stop offset="100%" stopColor={remainingColor} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`${gradientId}-accrued`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accruedColor} stopOpacity="0.15" />
            <stop offset="100%" stopColor={accruedColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines */}
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={pad.left}
            y1={pad.top + chartH * (1 - ratio)}
            x2={width - pad.right}
            y2={pad.top + chartH * (1 - ratio)}
            stroke="var(--border)"
            strokeWidth="1"
            strokeOpacity="0.24"
          />
        ))}

        {/* Y-axis */}
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={pad.top + chartH}
          stroke="var(--border)"
          strokeWidth="1"
        />

        {/* X-axis */}
        <line
          x1={pad.left}
          y1={pad.top + chartH}
          x2={width - pad.right}
          y2={pad.top + chartH}
          stroke="var(--border)"
          strokeWidth="1"
        />

        {/* Area under remaining line */}
        <path d={remainingArea} fill={`url(#${gradientId}-remaining)`} stroke="none" />

        {/* Remaining line (dashed) */}
        <path
          d={remainingPath}
          fill="none"
          stroke={remainingColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="8 6"
          className="stream-viz__line stream-viz__line--remaining"
        />

        {/* Area under accrued line */}
        <path d={accruedArea} fill={`url(#${gradientId}-accrued)`} stroke="none" />

        {/* Accrued line (solid) */}
        <path
          d={accruedPath}
          fill="none"
          stroke={accruedColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stream-viz__line stream-viz__line--accrued"
        />

        {/* Latest point markers */}
        <circle
          cx={xScale(dataPoints.length - 1)}
          cy={yScale(latestRemaining)}
          r="4"
          fill={remainingColor}
          stroke="var(--background)"
          strokeWidth="2"
        />
        <circle
          cx={xScale(dataPoints.length - 1)}
          cy={yScale(latestAccrued)}
          r="4"
          fill={accruedColor}
          stroke="var(--background)"
          strokeWidth="2"
        />

        {/* X-axis labels */}
        {axisLabels.map((dp, i) => {
          const idx = dataPoints.indexOf(dp);
          return (
            <text
              key={i}
              x={xScale(idx)}
              y={pad.top + chartH + 20}
              textAnchor="middle"
              fill="var(--muted)"
              fontSize="12"
              fontFamily="system-ui, sans-serif"
            >
              {formatDate(dp.date)}
            </text>
          );
        })}

        {/* Y-axis labels */}
        {[0, 0.5, 1].map((ratio) => {
          const val = values.minVal + values.range * ratio;
          return (
            <text
              key={ratio}
              x={pad.left - 8}
              y={pad.top + chartH * (1 - ratio) + 4}
              textAnchor="end"
              fill="var(--muted)"
              fontSize="12"
              fontFamily="system-ui, sans-serif"
            >
              {formatAmount(val)}
            </text>
          );
        })}
      </svg>

      <p className="stream-viz__helper">
        Estimate updates when StreamPay refreshes wallet and chain-observed activity.
      </p>
    </div>
  );
}

// ── Sparkline ───────────────────────────────────────────────────────────────

/**
 * Compact inline SVG sparkline showing the remaining-funds trajectory.
 * Designed for row-level use (e.g. stream list items).
 */
function SparklineChart({
  dataPoints,
  width = 120,
  height = 32,
}: {
  dataPoints: StreamVizDataPoint[];
  width?: number;
  height?: number;
}) {
  const remainingColor = cssVar("--chart-remaining-line", "#86EFAC");
  const pad = 2;
  const x0 = pad;
  const x1 = width - pad;
  const yTop = pad;
  const yBottom = height - pad;

  const values = dataPoints.map((d) => d.remaining);
  const maxVal = Math.max(...values, 1);
  const minVal = 0;
  const range = maxVal - minVal || 1;

  const xScale = (i: number) =>
    dataPoints.length > 1
      ? x0 + (i / (dataPoints.length - 1)) * (x1 - x0)
      : x0 + (x1 - x0) / 2;

  const yScale = (v: number) =>
    yBottom - ((v - minVal) / range) * (yBottom - yTop);

  const linePath = dataPoints
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(d.remaining)}`)
    .join(" ");

  const areaPath = `${linePath} L ${xScale(dataPoints.length - 1)} ${yBottom} L ${xScale(0)} ${yBottom} Z`;

  const latest = dataPoints[dataPoints.length - 1]?.remaining ?? 0;
  const remainingPercent = maxVal > 0 ? Math.round((latest / maxVal) * 100) : 0;

  return (
    <span
      className="stream-viz__sparkline"
      role="img"
      aria-label={`Funds remaining chart: ${remainingPercent}% remaining`}
      title={`${remainingPercent}% of funds remaining`}
      style={{ display: "inline-flex", lineHeight: 0 }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        focusable="false"
        aria-hidden="true"
      >
        {/* Area fill */}
        <path d={areaPath} fill={remainingColor} fillOpacity="0.15" stroke="none" />

        {/* Baseline */}
        <line
          x1={x0}
          y1={yBottom}
          x2={x1}
          y2={yBottom}
          stroke="var(--border)"
          strokeWidth="1"
          strokeOpacity="0.4"
        />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke={remainingColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Latest point */}
        <circle
          cx={xScale(dataPoints.length - 1)}
          cy={yScale(latest)}
          r="2.5"
          fill={remainingColor}
        />
      </svg>
    </span>
  );
}

// ── Data table ──────────────────────────────────────────────────────────────

/**
 * Semantic HTML table presenting stream data points for assistive technology
 * and non-visual contexts.
 */
function DataTableView({
  dataPoints,
  unit = "XLM",
}: {
  dataPoints: StreamVizDataPoint[];
  unit?: string;
}) {
  if (dataPoints.length === 0) {
    return <p className="stream-viz__empty">No data available.</p>;
  }

  return (
    <div className="stream-viz__table-wrap" role="region" aria-label="Stream data table">
      <table className="stream-viz__table">
        <caption className="sr-only">Stream funds over time</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Remaining ({unit})</th>
            <th scope="col">Accrued ({unit})</th>
          </tr>
        </thead>
        <tbody>
          {dataPoints.map((dp, i) => (
            <tr key={i}>
              <td>{formatDate(dp.date)}</td>
              <td className="stream-viz__cell-num">{formatAmount(dp.remaining)}</td>
              <td className="stream-viz__cell-num">{formatAmount(dp.accrued)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Error state ─────────────────────────────────────────────────────────────

function ChartError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="stream-viz__error" role="alert">
      <p className="stream-viz__error-message">{message}</p>
      {onRetry && (
        <button
          type="button"
          className="button button--secondary"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function ChartEmpty() {
  return (
    <div className="stream-viz__empty">
      <p>Not enough stream activity to chart yet.</p>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

/**
 * StreamViz — multi-style stream visualisation component.
 *
 * Accepts an ordered array of data points and renders one of three variants:
 * burn-down (default), sparkline, or data-table.
 *
 * @example
 * ```tsx
 * <StreamViz
 *   dataPoints={[
 *     { date: "2026-05-01", remaining: 1000, accrued: 0 },
 *     { date: "2026-05-15", remaining: 640, accrued: 360 },
 *   ]}
 *   variant="burn-down"
 *   unit="XLM"
 * />
 * ```
 */
export function StreamViz({
  dataPoints,
  variant = "burn-down",
  unit = "XLM",
  className = "",
  loading = false,
  error = null,
  onRetry,
}: StreamVizProps) {
  if (loading) {
    return (
      <div className={`stream-viz stream-viz--loading ${className}`.trim()}>
        {variant === "sparkline" ? (
          <div
            className="stream-viz__skeleton stream-viz__skeleton--sparkline"
            style={{ width: 120, height: 32 }}
            aria-hidden="true"
          />
        ) : (
          <ChartSkeleton />
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className={`stream-viz stream-viz--error ${className}`.trim()}>
        <ChartError message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (dataPoints.length === 0) {
    return (
      <div className={`stream-viz stream-viz--empty ${className}`.trim()}>
        <ChartEmpty />
      </div>
    );
  }

  if (variant === "data-table") {
    return (
      <div className={`stream-viz ${className}`.trim()}>
        <DataTableView dataPoints={dataPoints} unit={unit} />
      </div>
    );
  }

  if (variant === "sparkline") {
    return (
      <span className={`stream-viz stream-viz--sparkline ${className}`.trim()}>
        <SparklineChart dataPoints={dataPoints} />
      </span>
    );
  }

  return (
    <div
      className={`stream-viz stream-viz--burn-down ${className}`.trim()}
      role="figure"
      aria-label={`Stream funds chart with ${dataPoints.length} data points`}
    >
      <BurnDownChart dataPoints={dataPoints} unit={unit} />
      <p className="sr-only">
        Remaining: {formatAmount(dataPoints[dataPoints.length - 1]?.remaining ?? 0)} {unit}.
        Accrued: {formatAmount(dataPoints[dataPoints.length - 1]?.accrued ?? 0)} {unit}.
      </p>
      <details className="stream-viz__table-toggle">
        <summary className="stream-viz__table-summary">View data table</summary>
        <DataTableView dataPoints={dataPoints} unit={unit} />
      </details>
    </div>
  );
}

export default StreamViz;
