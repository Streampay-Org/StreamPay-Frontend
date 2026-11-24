import { parseBigInt } from "@/lib/format-bigint";
import type { StreamStatus } from "@/app/types/openapi";

const DAY_MS = 86_400_000;

const INTERVAL_MS: Record<string, bigint> = {
  second: 1_000n,
  minute: 60_000n,
  hour: 3_600_000n,
  day: 86_400_000n,
  week: 604_800_000n,
  month: 2_592_000_000n,
  year: 31_536_000_000n,
};

export interface ForecastStream {
  status: StreamStatus;
  rate: string;
  schedule?: string;
  senderAddress?: string | null;
  sender?: string | null;
  recipient: string;
  startTime?: string | number | null;
  endTime?: string | number | null;
  startedAt?: string | number | null;
  endsAt?: string | number | null;
  totalAmount?: string | null;
  amount?: string | null;
  releasedAmount?: string | null;
}

export interface DailyFlow {
  date: string;
  incoming: bigint;
  outgoing: bigint;
}

function parseTimestamp(value: string | number | null | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const timestamp =
    typeof value === "number"
      ? value < 1_000_000_000_000 ? value * 1_000 : value
      : /^\d+$/.test(value)
        ? Number(value) < 1_000_000_000_000
          ? Number(value) * 1_000
          : Number(value)
        : Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`Invalid stream timestamp: ${value}`);
  }
  return timestamp;
}

function parseRate(stream: ForecastStream): { amount: bigint; intervalMs: bigint } {
  const match = /^\s*(\d+(?:\.\d{1,7})?)(?:\s+[A-Za-z0-9_-]+\s*\/\s*(second|minute|hour|day|week|month|year))?\s*$/i.exec(
    stream.rate,
  );
  if (!match) {
    throw new RangeError(`Invalid stream rate: ${stream.rate}`);
  }

  const amount = parseBigInt(match[1]);
  if (amount === null) {
    throw new RangeError(`Invalid stream rate amount: ${stream.rate}`);
  }

  const interval = (match[2] ?? stream.schedule)?.toLowerCase();
  const intervalMs = interval ? INTERVAL_MS[interval] : undefined;
  if (intervalMs === undefined) {
    throw new RangeError(`Invalid stream schedule: ${stream.schedule ?? "missing"}`);
  }
  return { amount, intervalMs };
}

function parseAmount(value: string | null | undefined, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Invalid ${field}: ${value}`);
  }
  return BigInt(value);
}

/**
 * Projects UTC daily flows for the connected wallet. A self-stream is
 * excluded from both directions because it does not change the wallet's net flow.
 */
export function projectDailyFlows(
  streams: ForecastStream[],
  wallet: string,
  fromDate: Date,
  days: number,
): DailyFlow[] {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError("days must be a non-negative integer");
  }
  if (Number.isNaN(fromDate.getTime())) {
    throw new RangeError("fromDate must be a valid date");
  }

  const firstDay = Date.UTC(
    fromDate.getUTCFullYear(),
    fromDate.getUTCMonth(),
    fromDate.getUTCDate(),
  );
  const flows = Array.from({ length: days }, (_, index) => {
    const date = new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10);
    return { date, incoming: 0n, outgoing: 0n };
  });
  if (days === 0 || !wallet) return flows;

  const periodEnd = firstDay + days * DAY_MS;
  for (const stream of streams) {
    if (stream.status !== "active") continue;

    const sender = stream.senderAddress ?? stream.sender ?? null;
    const isIncoming = stream.recipient === wallet && sender !== wallet;
    const isOutgoing = sender === wallet && stream.recipient !== wallet;
    if (!isIncoming && !isOutgoing) continue;

    const { amount, intervalMs } = parseRate(stream);
    const start = parseTimestamp(stream.startedAt ?? stream.startTime) ?? firstDay;
    const end = parseTimestamp(stream.endsAt ?? stream.endTime) ?? periodEnd;
    const totalAmount = parseAmount(stream.totalAmount ?? stream.amount, "total amount");
    const capAmount =
      totalAmount === undefined
        ? undefined
        : totalAmount - (parseAmount(stream.releasedAmount, "released amount") ?? 0n);
    let remaining = capAmount === undefined ? undefined : capAmount > 0n ? capAmount : 0n;

    if (end <= start || end <= firstDay || start >= periodEnd || amount === 0n) continue;

    for (let index = 0; index < flows.length; index += 1) {
      const dayStart = firstDay + index * DAY_MS;
      const overlapStart = Math.max(dayStart, start);
      const overlapEnd = Math.min(dayStart + DAY_MS, end);
      if (overlapEnd <= overlapStart) continue;

      let projected = (amount * BigInt(overlapEnd - overlapStart)) / intervalMs;
      if (remaining !== undefined) {
        projected = projected > remaining ? remaining : projected;
        remaining -= projected;
      }

      if (isIncoming) flows[index].incoming += projected;
      if (isOutgoing) flows[index].outgoing += projected;
    }
  }

  return flows;
}
