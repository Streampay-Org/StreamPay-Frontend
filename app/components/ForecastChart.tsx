"use client";

import { formatBigInt } from "@/lib/format-bigint";
import type { DailyFlow } from "@/app/analytics/forecast";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 200;
const BASELINE = 176;
const MAX_BAR_HEIGHT = 150;

function barHeight(amount: bigint, maximum: bigint): number {
  if (amount <= 0n || maximum <= 0n) return 0;
  const scaled = (amount * BigInt(MAX_BAR_HEIGHT)) / maximum;
  return Number(scaled > 0n ? scaled : 1n);
}

function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${month}/${day}`;
}

export function ForecastChart({ flows }: { flows: DailyFlow[] }) {
  const maximum = flows.reduce(
    (current, flow) =>
      flow.incoming > current
        ? flow.incoming
        : flow.outgoing > current
          ? flow.outgoing
          : current,
    0n,
  );
  const slotWidth = flows.length > 0 ? CHART_WIDTH / flows.length : CHART_WIDTH;
  const barWidth = Math.max(1, Math.min(7, slotWidth * 0.32));
  const labelStep = Math.max(1, Math.ceil(flows.length / 7));

  return (
    <figure className="card" aria-labelledby="forecast-chart-heading">
      <figcaption id="forecast-chart-heading" className="text-lg font-semibold">
        Daily cash flow
      </figcaption>
      <div className="flex gap-4 py-3">
        <span className="flex items-center gap-2">
          <i className="h-3 w-3 rounded bg-emerald-500" aria-hidden="true" />
          Incoming
        </span>
        <span className="flex items-center gap-2">
          <i className="h-3 w-3 rounded bg-rose-500" aria-hidden="true" />
          Outgoing
        </span>
      </div>
      {flows.length === 0 ? (
        <p>No days in this forecast range.</p>
      ) : (
        <svg
          role="img"
          aria-label={`Daily incoming and outgoing cash flow for ${flows.length} UTC days`}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="w-full"
          preserveAspectRatio="none"
        >
          <line x1="0" y1={BASELINE} x2={CHART_WIDTH} y2={BASELINE} stroke="currentColor" opacity="0.3" />
          {flows.map((flow, index) => {
            const center = index * slotWidth + slotWidth / 2;
            const incomingHeight = barHeight(flow.incoming, maximum);
            const outgoingHeight = barHeight(flow.outgoing, maximum);
            return (
              <g key={flow.date}>
                <rect
                  x={center - barWidth - 1}
                  y={BASELINE - incomingHeight}
                  width={barWidth}
                  height={incomingHeight}
                  fill="#10b981"
                >
                  <title>{`${flow.date} incoming: ${formatBigInt(flow.incoming)} stroops`}</title>
                </rect>
                <rect
                  x={center + 1}
                  y={BASELINE - outgoingHeight}
                  width={barWidth}
                  height={outgoingHeight}
                  fill="#f43f5e"
                >
                  <title>{`${flow.date} outgoing: ${formatBigInt(flow.outgoing)} stroops`}</title>
                </rect>
                {index % labelStep === 0 && (
                  <text x={center} y="196" textAnchor="middle" fontSize="10" fill="currentColor">
                    {formatShortDate(flow.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
