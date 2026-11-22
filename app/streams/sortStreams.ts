import type { SortOption } from "../components/SortDropdown";
import type { StreamRowData } from "../components/StreamRow";

function parseTimestamp(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseRate(value: string): number | null {
  const normalized = value.replace(/,/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareNullableNumbers(
  a: number | null,
  b: number | null,
  direction: "asc" | "desc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

/**
 * Pure, stable sort for stream list rows.
 * Never mutates the input array.
 */
export function sortStreams(
  streams: readonly StreamRowData[],
  sort: SortOption,
): StreamRowData[] {
  if (streams.length <= 1) return [...streams];

  return [...streams].sort((a, b) => {
    switch (sort) {
      case "newest":
        return compareNullableNumbers(
          parseTimestamp(a.startedAt),
          parseTimestamp(b.startedAt),
          "desc",
        );
      case "oldest":
        return compareNullableNumbers(
          parseTimestamp(a.startedAt),
          parseTimestamp(b.startedAt),
          "asc",
        );
      case "recipient-asc":
        return a.recipient.localeCompare(b.recipient, undefined, {
          sensitivity: "base",
        });
      case "recipient-desc":
        return b.recipient.localeCompare(a.recipient, undefined, {
          sensitivity: "base",
        });
      case "rate-asc":
        return compareNullableNumbers(
          parseRate(a.rate),
          parseRate(b.rate),
          "asc",
        );
      case "rate-desc":
        return compareNullableNumbers(
          parseRate(a.rate),
          parseRate(b.rate),
          "desc",
        );
      default:
        return 0;
    }
  });
}
