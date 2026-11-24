import { safeStorage } from "./safeStorage";

/** Fallback display zone used on the server and whenever no valid preference is stored. */
export const DEFAULT_TIME_ZONE = "UTC";

/** Namespaced key holding the user's preferred display time zone. */
export const DISPLAY_TIME_ZONE_STORAGE_KEY = "streampay.display-time-zone";

/** Same-tab notification emitted when the preference changes. */
export const DISPLAY_TIME_ZONE_CHANGE_EVENT = "streampay:display-time-zone-change";

/** Common zones offered in the settings select when `Intl.supportedValuesOf` is unavailable. */
const CURATED_TIME_ZONES = [
  "UTC",
  "Africa/Lagos",
  "Africa/Nairobi",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Pacific/Auckland",
];

const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * Reports whether `timeZone` is an IANA zone accepted by `Intl`.
 *
 * @param timeZone Candidate zone identifier (for example `"America/New_York"`).
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Returns the browser's IANA time zone, falling back to UTC when it is unavailable. */
export function getBrowserTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Reads the stored display preference.
 *
 * Invalid or missing values resolve to {@link DEFAULT_TIME_ZONE} so a corrupt
 * entry can never break rendering.
 */
export function getDisplayTimeZone(): string {
  const stored = safeStorage.getItem(DISPLAY_TIME_ZONE_STORAGE_KEY);
  return isValidTimeZone(stored) ? stored : DEFAULT_TIME_ZONE;
}

/**
 * Persists the display preference.
 *
 * @returns `false` when the zone is invalid or storage is unavailable; the
 *   preference is left untouched in that case.
 */
export function setDisplayTimeZone(timeZone: string): boolean {
  if (!isValidTimeZone(timeZone)) return false;
  const saved = safeStorage.setItem(DISPLAY_TIME_ZONE_STORAGE_KEY, timeZone);
  if (saved) notifyDisplayTimeZoneChange();
  return saved;
}

/** Removes the stored preference so the app falls back to UTC. */
export function resetDisplayTimeZone(): void {
  safeStorage.removeItem(DISPLAY_TIME_ZONE_STORAGE_KEY);
  notifyDisplayTimeZoneChange();
}

function notifyDisplayTimeZoneChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DISPLAY_TIME_ZONE_CHANGE_EVENT));
}

/**
 * Subscribes to preference changes from this tab (custom event) and other
 * tabs (`storage` event).
 *
 * @returns An unsubscribe function.
 */
export function subscribeToDisplayTimeZone(
  listener: (timeZone: string) => void
): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DISPLAY_TIME_ZONE_STORAGE_KEY) return;
    listener(getDisplayTimeZone());
  };
  const onLocalChange = () => listener(getDisplayTimeZone());

  window.addEventListener("storage", onStorage);
  window.addEventListener(DISPLAY_TIME_ZONE_CHANGE_EVENT, onLocalChange);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DISPLAY_TIME_ZONE_CHANGE_EVENT, onLocalChange);
  };
}

/**
 * Lists selectable zones: UTC first, then a curated set plus the engine's
 * supported values (when `Intl.supportedValuesOf` is available).
 */
export function getSupportedTimeZones(): string[] {
  let supported: string[] = [];
  try {
    const valuesOf = (Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    }).supportedValuesOf;
    const values = valuesOf?.("timeZone");
    if (Array.isArray(values)) supported = values;
  } catch {
    supported = [];
  }

  const unique = new Set<string>([
    DEFAULT_TIME_ZONE,
    ...CURATED_TIME_ZONES,
    ...supported,
  ]);
  return Array.from(unique).filter(isValidTimeZone);
}

/**
 * Formats `date` in `timeZone`, including the short zone name.
 *
 * Invalid zones fall back to UTC instead of throwing.
 */
export function formatDateTimeInTimeZone(date: Date, timeZone?: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat("en", {
      ...DATE_TIME_FORMAT_OPTIONS,
      timeZone: zone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", {
      ...DATE_TIME_FORMAT_OPTIONS,
      timeZone: DEFAULT_TIME_ZONE,
    }).format(date);
  }
}
