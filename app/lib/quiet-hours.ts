/**
 * Quiet Hours Scheduling & Timezone Safety Engine
 * 
 * Provides deterministic, timezone-aware quiet hours evaluation, validation,
 * suppression rules, and next-delivery calculations.
 * 
 * Key Invariants:
 * 1. Storage & API inputs specify IANA timezones (e.g., 'America/New_York', 'UTC', 'Europe/London').
 * 2. DST transitions (spring forward, fall back) and cross-midnight boundaries are handled deterministically.
 * 3. Critical alerts (settlement failure, payment failure, stream cancellation) can bypass quiet hours.
 * 4. Input validation strictly rejects malformed time, invalid timezone names, and invalid day indexes.
 */

export interface QuietHoursConfig {
  /** Whether quiet hours suppression is actively enabled */
  enabled: boolean;
  /** Start time in 24-hour HH:mm format (inclusive, e.g. "22:00") */
  startTime: string;
  /** End time in 24-hour HH:mm format (exclusive, e.g. "08:00") */
  endTime: string;
  /** Valid IANA timezone string (e.g. "UTC", "America/New_York", "Asia/Tokyo") */
  timezone: string;
  /** Days of week when quiet hours apply (0 = Sunday, 1 = Monday, ..., 6 = Saturday). Defaults to all days. */
  daysOfWeek?: number[];
  /** If true, critical events (e.g. settlementFailed, paymentFailed) bypass quiet hours. Defaults to true. */
  allowCriticalAlerts?: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: false,
  startTime: "22:00",
  endTime: "08:00",
  timezone: "UTC",
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  allowCriticalAlerts: true,
};

/** Critical event types that bypass quiet hours when allowCriticalAlerts is true */
export const CRITICAL_EVENT_TYPES = new Set([
  "paymentFailed",
  "settlementFailed",
  "streamCancelled",
  "fundingLow",
  "lowBalance",
  "securityAlert",
]);

const TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates whether a given timezone string is a valid IANA timezone identifier.
 */
export function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim().length === 0 || tz.length > 100) {
    return false;
  }
  const cleanTz = tz.trim();
  try {
    // Intl.DateTimeFormat will throw a RangeError for invalid timezone strings
    Intl.DateTimeFormat(undefined, { timeZone: cleanTz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates whether a time string matches the HH:mm 24-hour format (00:00 to 23:59).
 */
export function isValidTimeFormat(time: unknown): time is string {
  return typeof time === "string" && TIME_REGEX.test(time.trim());
}

/**
 * Parses "HH:mm" into total minutes from start of day (0..1439).
 */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Validates partial quiet hours payload.
 */
export function validatePartialQuietHours(
  payload: unknown,
): { valid: true; value: Partial<QuietHoursConfig> } | { valid: false; error: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { valid: false, error: "Quiet hours configuration must be a non-null object." };
  }

  const raw = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    "enabled",
    "startTime",
    "endTime",
    "timezone",
    "daysOfWeek",
    "allowCriticalAlerts",
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Unrecognized quiet hours field: ${key}` };
    }
  }

  const partial: Partial<QuietHoursConfig> = {};

  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") {
      return { valid: false, error: "Field 'enabled' must be a boolean." };
    }
    partial.enabled = raw.enabled;
  }

  if ("startTime" in raw) {
    if (!isValidTimeFormat(raw.startTime)) {
      return { valid: false, error: "Field 'startTime' must be a valid 24-hour time string in HH:mm format." };
    }
    partial.startTime = (raw.startTime as string).trim();
  }

  if ("endTime" in raw) {
    if (!isValidTimeFormat(raw.endTime)) {
      return { valid: false, error: "Field 'endTime' must be a valid 24-hour time string in HH:mm format." };
    }
    partial.endTime = (raw.endTime as string).trim();
  }

  if ("timezone" in raw) {
    if (!isValidIanaTimezone(raw.timezone)) {
      return {
        valid: false,
        error: "Field 'timezone' must be a valid IANA timezone identifier (e.g., 'UTC', 'America/New_York').",
      };
    }
    partial.timezone = (raw.timezone as string).trim();
  }

  if ("daysOfWeek" in raw) {
    if (!Array.isArray(raw.daysOfWeek)) {
      return { valid: false, error: "Field 'daysOfWeek' must be an array of integers (0 to 6)." };
    }
    const seen = new Set<number>();
    for (const day of raw.daysOfWeek) {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
        return { valid: false, error: "Each element in 'daysOfWeek' must be an integer between 0 (Sunday) and 6 (Saturday)." };
      }
      if (seen.has(day)) {
        return { valid: false, error: "Field 'daysOfWeek' contains duplicate day indexes." };
      }
      seen.add(day);
    }
    partial.daysOfWeek = Array.from(seen).sort((a, b) => a - b);
  }

  if ("allowCriticalAlerts" in raw) {
    if (typeof raw.allowCriticalAlerts !== "boolean") {
      return { valid: false, error: "Field 'allowCriticalAlerts' must be a boolean." };
    }
    partial.allowCriticalAlerts = raw.allowCriticalAlerts;
  }

  return { valid: true, value: partial };
}

/**
 * Validates and normalizes a complete quiet hours configuration payload with defaults.
 */
export function validateQuietHoursConfig(
  payload: unknown,
): { valid: true; value: QuietHoursConfig } | { valid: false; error: string } {
  const partialResult = validatePartialQuietHours(payload);
  if (!partialResult.valid) {
    return partialResult;
  }

  const raw = partialResult.value;
  const result: QuietHoursConfig = {
    enabled: raw.enabled !== undefined ? raw.enabled : DEFAULT_QUIET_HOURS.enabled,
    startTime: raw.startTime !== undefined ? raw.startTime : DEFAULT_QUIET_HOURS.startTime,
    endTime: raw.endTime !== undefined ? raw.endTime : DEFAULT_QUIET_HOURS.endTime,
    timezone: raw.timezone !== undefined ? raw.timezone : DEFAULT_QUIET_HOURS.timezone,
    daysOfWeek: raw.daysOfWeek !== undefined ? raw.daysOfWeek : DEFAULT_QUIET_HOURS.daysOfWeek,
    allowCriticalAlerts:
      raw.allowCriticalAlerts !== undefined
        ? raw.allowCriticalAlerts
        : DEFAULT_QUIET_HOURS.allowCriticalAlerts,
  };

  return { valid: true, value: result };
}

/**
 * Extracts zoned calendar and wall-clock components for a given instant in a specific timezone.
 */
export function getZonedTimeComponents(
  date: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });

  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const hour = parseInt(map.hour, 10) % 24; // Handle 24:00 normalization if returned by Intl
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);
  const day = parseInt(map.day, 10);
  const month = parseInt(map.month, 10);
  const year = parseInt(map.year, 10);
  const dayOfWeek = weekdayMap[map.weekday] ?? 0;

  return { year, month, day, hour, minute, second, dayOfWeek };
}

/**
 * Determines if quiet hours are actively in effect at the specified instant.
 *
 * Overnight windows (e.g. 22:00 -> 08:00) starting on day D apply:
 * - On day D from 22:00 until 23:59:59 (checked against day D's active schedule)
 * - On day D+1 from 00:00 until 07:59:59 (checked against the preceding day D's active schedule)
 */
export function isQuietHoursActive(
  config: QuietHoursConfig | undefined | null,
  atDate: Date = new Date(),
): boolean {
  if (!config || !config.enabled) {
    return false;
  }

  const timezone = isValidIanaTimezone(config.timezone) ? config.timezone : "UTC";
  const startMin = parseTimeToMinutes(config.startTime);
  const endMin = parseTimeToMinutes(config.endTime);
  const daysOfWeek = config.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
  const activeDaysSet = new Set(daysOfWeek);

  const { hour, minute, dayOfWeek } = getZonedTimeComponents(atDate, timezone);
  const currentMin = hour * 60 + minute;

  if (startMin === endMin) {
    // Full 24-hour quiet mode on configured days
    return activeDaysSet.has(dayOfWeek);
  }

  if (startMin < endMin) {
    // Same-day window
    if (!activeDaysSet.has(dayOfWeek)) {
      return false;
    }
    return currentMin >= startMin && currentMin < endMin;
  }

  // Overnight window (startMin > endMin, e.g. 22:00 to 08:00)
  if (currentMin >= startMin) {
    // Evening portion: belongs to today's schedule
    return activeDaysSet.has(dayOfWeek);
  }

  if (currentMin < endMin) {
    // Morning portion (after midnight): belongs to yesterday's schedule
    const previousDayOfWeek = (dayOfWeek + 6) % 7;
    return activeDaysSet.has(previousDayOfWeek);
  }

  return false;
}

export interface SuppressionDecision {
  suppress: boolean;
  reason?: "QUIET_HOURS_ACTIVE" | "CRITICAL_ALERT_BYPASS" | "NOT_IN_QUIET_HOURS" | "DISABLED";
  scheduledFor?: Date;
}

/**
 * Computes the next instant (in UTC) when the active quiet hours window ends.
 * If not currently in quiet hours or disabled, returns null.
 */
export function getNextQuietHoursEnd(
  config: QuietHoursConfig | undefined | null,
  fromDate: Date = new Date(),
): Date | null {
  if (!config || !config.enabled) {
    return null;
  }

  if (!isQuietHoursActive(config, fromDate)) {
    return null;
  }

  const timezone = isValidIanaTimezone(config.timezone) ? config.timezone : "UTC";
  
  // Step forward up to 48 hours to find the exact transition where isQuietHoursActive becomes false
  const testDate = new Date(fromDate.getTime());
  const maxSearchTime = fromDate.getTime() + 48 * 60 * 60 * 1000;
  
  while (testDate.getTime() < maxSearchTime && isQuietHoursActive(config, testDate)) {
    testDate.setTime(testDate.getTime() + 60 * 1000); // 1-minute increment
  }

  // Reset seconds & milliseconds to clean 00 boundary
  const zoned = getZonedTimeComponents(testDate, timezone);
  const cleanEnd = new Date(testDate.getTime() - (zoned.second * 1000) - testDate.getUTCMilliseconds());
  
  return cleanEnd;
}

/**
 * Decides whether a notification for a specific event should be suppressed.
 * Handles critical alert bypasses and calculates delayed delivery timestamp.
 */
export function shouldSuppressNotification(
  config: QuietHoursConfig | undefined | null,
  eventType: string,
  atDate: Date = new Date(),
): SuppressionDecision {
  if (!config || !config.enabled) {
    return { suppress: false, reason: "DISABLED" };
  }

  const isCritical = CRITICAL_EVENT_TYPES.has(eventType);
  if (isCritical && config.allowCriticalAlerts !== false) {
    return { suppress: false, reason: "CRITICAL_ALERT_BYPASS" };
  }

  const inQuiet = isQuietHoursActive(config, atDate);
  if (!inQuiet) {
    return { suppress: false, reason: "NOT_IN_QUIET_HOURS" };
  }

  const scheduledFor = getNextQuietHoursEnd(config, atDate) ?? undefined;
  return {
    suppress: true,
    reason: "QUIET_HOURS_ACTIVE",
    scheduledFor,
  };
}
