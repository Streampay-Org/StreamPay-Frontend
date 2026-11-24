"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import {
  DEFAULT_TIME_ZONE,
  formatDateTimeInTimeZone,
  getBrowserTimeZone,
  getDisplayTimeZone,
  getSupportedTimeZones,
  isValidTimeZone,
  setDisplayTimeZone,
  subscribeToDisplayTimeZone,
} from "../../lib/timezone";

/**
 * Display time zone picker for the Settings page.
 *
 * Persists the choice through `safeStorage` and previews the current time in
 * the selected zone. The stored value is applied after mount so the server
 * render and the first client render agree.
 */
export function TimeZoneSettings() {
  const selectId = useId();
  const previewId = useId();
  const errorId = useId();

  const [browserTimeZone, setBrowserTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [selectedTimeZone, setSelectedTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [supportedTimeZones, setSupportedTimeZones] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const browserZone = getBrowserTimeZone();
    const storedZone = getDisplayTimeZone();

    setBrowserTimeZone(browserZone);
    setSelectedTimeZone(storedZone);
    // Resolve the option list after mount so server and client markup agree.
    setSupportedTimeZones(getSupportedTimeZones());
    setPreview(formatDateTimeInTimeZone(new Date(), storedZone));

    return subscribeToDisplayTimeZone((zone) => {
      setSelectedTimeZone(zone);
      setPreview(formatDateTimeInTimeZone(new Date(), zone));
    });
  }, []);

  const timeZoneOptions = useMemo(() => {
    const zones = new Set<string>([DEFAULT_TIME_ZONE, selectedTimeZone]);
    if (browserTimeZone !== DEFAULT_TIME_ZONE) zones.add(browserTimeZone);
    for (const zone of supportedTimeZones) {
      if (zone !== browserTimeZone) zones.add(zone);
    }

    return Array.from(zones)
      .filter(isValidTimeZone)
      .sort((a, b) => {
        if (a === DEFAULT_TIME_ZONE) return -1;
        if (b === DEFAULT_TIME_ZONE) return 1;
        return a.localeCompare(b);
      });
  }, [browserTimeZone, selectedTimeZone, supportedTimeZones]);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextZone = event.target.value;

    if (!isValidTimeZone(nextZone)) {
      setError(`“${nextZone}” is not a valid time zone.`);
      return;
    }

    const saved = setDisplayTimeZone(nextZone);
    setSelectedTimeZone(nextZone);
    setPreview(formatDateTimeInTimeZone(new Date(), nextZone));
    setError(
      saved
        ? null
        : "Your browser blocked local storage, so this preference will not be saved."
    );
  };

  return (
    <div className="setting-item setting-item--stacked">
      <div className="setting-item__info">
        <label className="setting-item__label" htmlFor={selectId}>
          Display time zone
        </label>
        <p className="setting-item__description">
          Choose the zone used for absolute timestamps in activity feeds and
          tooltips.
        </p>
        <p
          className="setting-item__description"
          aria-live="polite"
          id={previewId}
        >
          {preview ? `Preview: ${preview}` : "Preview: —"}
        </p>
        {error && (
          <p
            className="input-error"
            id={errorId}
            role="alert"
            style={{ color: "var(--system-error-text)", fontSize: "0.8125rem" }}
          >
            {error}
          </p>
        )}
      </div>
      <div className="setting-item__actions">
        <select
          aria-describedby={previewId}
          aria-invalid={Boolean(error)}
          className="input input--select"
          id={selectId}
          onChange={handleChange}
          value={selectedTimeZone}
        >
          {timeZoneOptions.map((zone) => {
            const isBrowserZone =
              zone === browserTimeZone && zone !== DEFAULT_TIME_ZONE;
            return (
              <option key={zone} value={zone}>
                {zone === DEFAULT_TIME_ZONE
                  ? "UTC"
                  : isBrowserZone
                    ? `Browser default (${zone})`
                    : zone}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}
