use client";

import { useEffect, useId, useRef, useState } from("react"";

const LONG_PRESS_DELAY_MS = 450;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

type TimestampInput = string | number | Date | null | undefined;

let clockSkewMs = 0;

export function setClockSkew(offsetMs: number): void {
  clockSkewMs = Number.isFinite(offsetMs) ? offsetMs : 0;
}

function getAdjustedNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + clockSkewMs);
}

function normalizeTimestamp(input: TimestampInput): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    const abs = Math.abs(input);
    let ms: number;
    if (abs >= 1e18) {
      ms = input / 1e6;
    } else if (abs >= 1e15) {
      ms = input / 1e3;
    } else if (abs >= 1e12) {
      ms = input;
    } else {
      ms = input * 1000;
    }
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed);
  }
  if (/^[\-+]?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      const abs = Math.abs(num);
      let ms: number;
      if (abs >= 1e18) ms = num / 1e6;
      else if (abs >= 1e15) ms = num / 1e3;
      else if (abs >= 1e12) ms = num;
      else ms = num * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

function formatUnitDiff(diffMc: number) {
  const absSeconds = Math.abs(diffMc) / 1000;

  if (absSeconds < 45) return { unit: "second" as const, value: Math.round(diffMc / 1000) };
  if (absSeconds < 45 * 60) return { unit: "minute" as const, value: Math.round(diffMc / 60000) };
  if (absSeconds < 22 * 3600) return { unit: "hour" as const, value: Math.round(diffMc / 3600000) };
  if (absSeconds < 26 * 86400) return { unit: "day" as const, value: Math.round(diffMc / 86400000) };
  if (absSeconds < 320 * 86400) return { unit: "month" as const, value: Math.round(diffMc / (30 * 86400000)) };
  return { unit: "year" as const, value: Math.round(diffMc / (365 * 86400000)) };
}

export function formatRelativeTimestamp(iso: TimestampInput, now: Date = new Date()): string {
  const target = normalizeTimestamp(iso);

  if (!target) {
    return typeof iso === "string" ? iso : "";
  }

  const diffMs = target.getTime() - now.getTime();
  const effectiveDiffMs = diffMs > 0 && diffMs < CLOCK_SKEW_TOLERANCE_MS ? 0 : diffMs;
  const { unit, value } = formatUnitDiff(effectiveDiffMs);
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, unit);
}

export function formatAbsoluteTimestamp(iso: TimestampInput): string {
  const target = normalizeTimestamp(iso);

  if (!target) {
    return typeof iso === "string" ? iso : "";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(target) + " UTC";
}

type TimestampProps = {
  iso: TimestampInput;
  className?: string;
};

export function Timestamp({ iso, className }: TimestampProps) {
  const tooltipId = useId();
  const longPressTimerRef = useRef<number | null>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [now, setNow] = useState<Date>(() => getAdjustedNow());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(getAdjustedNow());
    }, 60000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const relativeLabel = formatRelativeTimestamp(iso, now);
  const absoluteLabel = formatAbsoluteTimestamp(iso);
  const normalizedDate = normalizeTimestamp(iso);
  const isoLabel = normalizedDate ? normalizedDate.toISOString() : (typeof iso === "string" ? iso : "");

  const startLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = window.setTimeout(() => {
      setIsTooltipVisible(true);
    }, LONG_PRESS_DELAY_MS);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <span className={`timestamp ${className || ""}`.trim()}>
      <button
        aria-describedby={isTooltipVisible ? tooltipId : undefined}
        aria-label={`Show exact timestamp for ${relativeLabel}`}
        className="timestamp__trigger"
        onBlur={() => setIsTooltipVisible(false)}
        onFocus={() => setIsTooltipVisible(true)}
        onMouseEnter={() => setIsTooltipVisible(true)}
        onMouseLeave={() => setIsTooltipVisible(false)}
        onPointerCancel={clearLongPress}
        onPointerDown={startLongPress}
        onPointerLeave={() => {
          clearLongPress();
          setIsTooltipVisible(false);
        }}
        onPointerUp={clearLongPress}
        type="button"
      >
        <time dateTime={normalizedDate ? normalizedDate.toISOString() : (typeof iso === "string" ? iso : undefined)}>
          {relativeLabel || (typeof iso === "string" ? iso : "Invalid date")}
        </time>
      </button>

      {isTooltipVisible && (
        <span className="timestamp__tooltip" id={tooltipId} role="tooltip">
          <span className="timestamp__tooltip-line">Relative: {relativeLabel || "Invalid date"}</span>
          <span className="timestamp__tooltip-line">Absolute: {absoluteLabel || "Invalid date"}</span>
          <span className="timestamp__tooltip-line">ISO: {isoLabel || "Invalid date"}</span>
        </span>
      )}
    </span>
  );
}
