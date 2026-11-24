/**
 * @jest-environment jsdom
 */

import {
  DEFAULT_TIME_ZONE,
  DISPLAY_TIME_ZONE_STORAGE_KEY,
  formatDateTimeInTimeZone,
  getBrowserTimeZone,
  getDisplayTimeZone,
  getSupportedTimeZones,
  isValidTimeZone,
  resetDisplayTimeZone,
  setDisplayTimeZone,
  subscribeToDisplayTimeZone,
} from "./timezone";

describe("timezone", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  describe("isValidTimeZone", () => {
    it("accepts IANA zones", () => {
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    });

    it("rejects empty, unknown, and non-string values", () => {
      expect(isValidTimeZone("")).toBe(false);
      expect(isValidTimeZone("   ")).toBe(false);
      expect(isValidTimeZone("Mars/Olympus")).toBe(false);
      expect(isValidTimeZone(null)).toBe(false);
      expect(isValidTimeZone(undefined)).toBe(false);
      expect(isValidTimeZone(42)).toBe(false);
    });
  });

  describe("display preference", () => {
    it("defaults to UTC when nothing is stored", () => {
      expect(getDisplayTimeZone()).toBe(DEFAULT_TIME_ZONE);
    });

    it("persists and reads a valid zone", () => {
      expect(setDisplayTimeZone("America/New_York")).toBe(true);
      expect(
        window.localStorage.getItem(DISPLAY_TIME_ZONE_STORAGE_KEY)
      ).toBe("America/New_York");
      expect(getDisplayTimeZone()).toBe("America/New_York");
    });

    it("falls back to UTC for invalid stored values", () => {
      window.localStorage.setItem(
        DISPLAY_TIME_ZONE_STORAGE_KEY,
        "Mars/Olympus"
      );
      expect(getDisplayTimeZone()).toBe(DEFAULT_TIME_ZONE);
    });

    it("rejects invalid zones without touching the stored preference", () => {
      setDisplayTimeZone("Asia/Tokyo");

      expect(setDisplayTimeZone("Nope/Nope")).toBe(false);
      expect(getDisplayTimeZone()).toBe("Asia/Tokyo");
    });

    it("degrades gracefully when storage is blocked", () => {
      jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });

      expect(setDisplayTimeZone("Asia/Tokyo")).toBe(false);
      expect(getDisplayTimeZone()).toBe(DEFAULT_TIME_ZONE);
    });

    it("reset restores the UTC fallback", () => {
      setDisplayTimeZone("Asia/Tokyo");
      resetDisplayTimeZone();
      expect(getDisplayTimeZone()).toBe(DEFAULT_TIME_ZONE);
    });
  });

  describe("formatDateTimeInTimeZone", () => {
    const instant = new Date("2026-06-27T10:00:00.000Z");

    it("formats the same instant in different zones", () => {
      expect(formatDateTimeInTimeZone(instant, "UTC")).toBe(
        "Jun 27, 2026, 10:00 AM UTC"
      );
      expect(formatDateTimeInTimeZone(instant, "America/New_York")).toBe(
        "Jun 27, 2026, 6:00 AM EDT"
      );
      expect(formatDateTimeInTimeZone(instant, "Asia/Kolkata")).toBe(
        "Jun 27, 2026, 3:30 PM GMT+5:30"
      );
    });

    it("falls back to UTC for invalid zones", () => {
      expect(formatDateTimeInTimeZone(instant, "Bad/Zone")).toBe(
        "Jun 27, 2026, 10:00 AM UTC"
      );
      expect(formatDateTimeInTimeZone(instant)).toBe(
        "Jun 27, 2026, 10:00 AM UTC"
      );
    });
  });

  describe("getBrowserTimeZone", () => {
    it("returns a valid IANA zone", () => {
      expect(isValidTimeZone(getBrowserTimeZone())).toBe(true);
    });
  });

  describe("getSupportedTimeZones", () => {
    it("lists UTC first without duplicates", () => {
      const zones = getSupportedTimeZones();

      expect(zones[0]).toBe(DEFAULT_TIME_ZONE);
      expect(zones).toContain("America/New_York");
      expect(zones).toContain("Asia/Kolkata");
      expect(new Set(zones).size).toBe(zones.length);
    });
  });

  describe("subscribeToDisplayTimeZone", () => {
    it("notifies subscribers when the preference changes in this tab", () => {
      const listener = jest.fn();
      const unsubscribe = subscribeToDisplayTimeZone(listener);

      setDisplayTimeZone("Europe/Berlin");
      expect(listener).toHaveBeenCalledWith("Europe/Berlin");

      unsubscribe();
      setDisplayTimeZone("Europe/Paris");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies subscribers on storage events from other tabs", () => {
      const listener = jest.fn();
      const unsubscribe = subscribeToDisplayTimeZone(listener);

      window.localStorage.setItem(DISPLAY_TIME_ZONE_STORAGE_KEY, "Asia/Tokyo");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DISPLAY_TIME_ZONE_STORAGE_KEY,
          newValue: "Asia/Tokyo",
        })
      );

      expect(listener).toHaveBeenCalledWith("Asia/Tokyo");
      unsubscribe();
    });
  });
});
