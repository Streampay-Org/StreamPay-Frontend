import {
  isValidIanaTimezone,
  isValidTimeFormat,
  parseTimeToMinutes,
  validateQuietHoursConfig,
  getZonedTimeComponents,
  isQuietHoursActive,
  shouldSuppressNotification,
  getNextQuietHoursEnd,
  DEFAULT_QUIET_HOURS,
  QuietHoursConfig,
} from "./quiet-hours";

describe("quiet-hours engine", () => {
  describe("isValidIanaTimezone", () => {
    it("accepts valid standard IANA timezones", () => {
      expect(isValidIanaTimezone("UTC")).toBe(true);
      expect(isValidIanaTimezone("America/New_York")).toBe(true);
      expect(isValidIanaTimezone("Europe/London")).toBe(true);
      expect(isValidIanaTimezone("Asia/Tokyo")).toBe(true);
      expect(isValidIanaTimezone("Australia/Sydney")).toBe(true);
      expect(isValidIanaTimezone("Africa/Lagos")).toBe(true);
    });

    it("rejects invalid, malformed, or malicious timezone strings", () => {
      expect(isValidIanaTimezone("")).toBe(false);
      expect(isValidIanaTimezone("   ")).toBe(false);
      expect(isValidIanaTimezone("Invalid/Timezone")).toBe(false);
      expect(isValidIanaTimezone("Mars/Olympus")).toBe(false);
      expect(isValidIanaTimezone(null)).toBe(false);
      expect(isValidIanaTimezone(undefined)).toBe(false);
      expect(isValidIanaTimezone(123)).toBe(false);
      expect(isValidIanaTimezone({})).toBe(false);
      expect(isValidIanaTimezone("A".repeat(101))).toBe(false);
    });
  });

  describe("isValidTimeFormat", () => {
    it("accepts valid 24h format HH:mm times", () => {
      expect(isValidTimeFormat("00:00")).toBe(true);
      expect(isValidTimeFormat("08:30")).toBe(true);
      expect(isValidTimeFormat("12:00")).toBe(true);
      expect(isValidTimeFormat("22:00")).toBe(true);
      expect(isValidTimeFormat("23:59")).toBe(true);
    });

    it("rejects invalid times and non-string inputs", () => {
      expect(isValidTimeFormat("24:00")).toBe(false);
      expect(isValidTimeFormat("12:60")).toBe(false);
      expect(isValidTimeFormat("8:30")).toBe(false);
      expect(isValidTimeFormat("22:0")).toBe(false);
      expect(isValidTimeFormat("noon")).toBe(false);
      expect(isValidTimeFormat("")).toBe(false);
      expect(isValidTimeFormat(null)).toBe(false);
      expect(isValidTimeFormat(1200)).toBe(false);
    });
  });

  describe("parseTimeToMinutes", () => {
    it("correctly computes minutes since midnight", () => {
      expect(parseTimeToMinutes("00:00")).toBe(0);
      expect(parseTimeToMinutes("01:30")).toBe(90);
      expect(parseTimeToMinutes("12:00")).toBe(720);
      expect(parseTimeToMinutes("22:00")).toBe(1320);
      expect(parseTimeToMinutes("23:59")).toBe(1439);
    });
  });

  describe("validateQuietHoursConfig", () => {
    it("validates a full valid config payload", () => {
      const payload = {
        enabled: true,
        startTime: "23:00",
        endTime: "07:00",
        timezone: "America/New_York",
        daysOfWeek: [1, 2, 3, 4, 5],
        allowCriticalAlerts: false,
      };

      const result = validateQuietHoursConfig(payload);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value).toEqual(payload);
      }
    });

    it("fills defaults for missing optional fields", () => {
      const payload = {
        enabled: true,
      };

      const result = validateQuietHoursConfig(payload);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value).toEqual({
          enabled: true,
          startTime: DEFAULT_QUIET_HOURS.startTime,
          endTime: DEFAULT_QUIET_HOURS.endTime,
          timezone: DEFAULT_QUIET_HOURS.timezone,
          daysOfWeek: DEFAULT_QUIET_HOURS.daysOfWeek,
          allowCriticalAlerts: DEFAULT_QUIET_HOURS.allowCriticalAlerts,
        });
      }
    });

    it("rejects non-object or null payloads", () => {
      expect(validateQuietHoursConfig(null).valid).toBe(false);
      expect(validateQuietHoursConfig("string").valid).toBe(false);
      expect(validateQuietHoursConfig([]).valid).toBe(false);
    });

    it("rejects unrecognized fields", () => {
      const result = validateQuietHoursConfig({ enabled: true, extraProperty: true });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("Unrecognized quiet hours field");
      }
    });

    it("rejects invalid time format", () => {
      expect(validateQuietHoursConfig({ startTime: "25:00" }).valid).toBe(false);
      expect(validateQuietHoursConfig({ endTime: "invalid" }).valid).toBe(false);
    });

    it("rejects invalid timezone identifier", () => {
      const result = validateQuietHoursConfig({ timezone: "Invalid/Timezone" });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("valid IANA timezone");
      }
    });

    it("rejects invalid daysOfWeek values and duplicates", () => {
      expect(validateQuietHoursConfig({ daysOfWeek: "1,2,3" }).valid).toBe(false);
      expect(validateQuietHoursConfig({ daysOfWeek: [7] }).valid).toBe(false);
      expect(validateQuietHoursConfig({ daysOfWeek: [-1] }).valid).toBe(false);
      expect(validateQuietHoursConfig({ daysOfWeek: [1.5] }).valid).toBe(false);
      expect(validateQuietHoursConfig({ daysOfWeek: [1, 2, 2] }).valid).toBe(false);
    });

    it("sorts daysOfWeek array", () => {
      const result = validateQuietHoursConfig({ daysOfWeek: [5, 1, 3] });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value.daysOfWeek).toEqual([1, 3, 5]);
      }
    });
  });

  describe("getZonedTimeComponents", () => {
    it("accurately converts UTC instant to local zoned calendar parts", () => {
      // 2026-06-15T15:30:00Z
      const utcDate = new Date(Date.UTC(2026, 5, 15, 15, 30, 0));

      const utcParts = getZonedTimeComponents(utcDate, "UTC");
      expect(utcParts.hour).toBe(15);
      expect(utcParts.minute).toBe(30);
      expect(utcParts.day).toBe(15);
      expect(utcParts.month).toBe(6);
      expect(utcParts.year).toBe(2026);

      // In New York (EDT is UTC-4 in June) -> 11:30
      const nyParts = getZonedTimeComponents(utcDate, "America/New_York");
      expect(nyParts.hour).toBe(11);
      expect(nyParts.minute).toBe(30);

      // In Tokyo (JST is UTC+9) -> 00:30 on June 16
      const tokyoParts = getZonedTimeComponents(utcDate, "Asia/Tokyo");
      expect(tokyoParts.hour).toBe(0);
      expect(tokyoParts.minute).toBe(30);
      expect(tokyoParts.day).toBe(16);
    });
  });

  describe("isQuietHoursActive", () => {
    it("returns false when quiet hours is disabled or config is null", () => {
      const config: QuietHoursConfig = {
        ...DEFAULT_QUIET_HOURS,
        enabled: false,
      };
      expect(isQuietHoursActive(config, new Date())).toBe(false);
      expect(isQuietHoursActive(null, new Date())).toBe(false);
      expect(isQuietHoursActive(undefined, new Date())).toBe(false);
    });

    describe("Same-day window (e.g. 13:00 to 15:00 UTC)", () => {
      const config: QuietHoursConfig = {
        enabled: true,
        startTime: "13:00",
        endTime: "15:00",
        timezone: "UTC",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        allowCriticalAlerts: true,
      };

      it("returns false before start time", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 12, 59, 59));
        expect(isQuietHoursActive(config, date)).toBe(false);
      });

      it("returns true at exact start time", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 13, 0, 0));
        expect(isQuietHoursActive(config, date)).toBe(true);
      });

      it("returns true during window", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 14, 30, 0));
        expect(isQuietHoursActive(config, date)).toBe(true);
      });

      it("returns false at exact end time", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 15, 0, 0));
        expect(isQuietHoursActive(config, date)).toBe(false);
      });
    });

    describe("Overnight window (e.g. 22:00 to 08:00 UTC)", () => {
      const config: QuietHoursConfig = {
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        allowCriticalAlerts: true,
      };

      it("returns false during daytime before quiet window", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
        expect(isQuietHoursActive(config, date)).toBe(false);
      });

      it("returns true in late evening", () => {
        const date = new Date(Date.UTC(2026, 5, 15, 22, 15, 0));
        expect(isQuietHoursActive(config, date)).toBe(true);
      });

      it("returns true in early morning after midnight", () => {
        const date = new Date(Date.UTC(2026, 5, 16, 3, 45, 0));
        expect(isQuietHoursActive(config, date)).toBe(true);
      });

      it("returns true right before end time (07:59)", () => {
        const date = new Date(Date.UTC(2026, 5, 16, 7, 59, 0));
        expect(isQuietHoursActive(config, date)).toBe(true);
      });

      it("returns false at end time (08:00)", () => {
        const date = new Date(Date.UTC(2026, 5, 16, 8, 0, 0));
        expect(isQuietHoursActive(config, date)).toBe(false);
      });
    });

    describe("Timezone safety with offset differences", () => {
      it("correctly evaluates quiet hours in America/New_York (UTC-4 in EDT)", () => {
        const config: QuietHoursConfig = {
          enabled: true,
          startTime: "22:00",
          endTime: "08:00",
          timezone: "America/New_York",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          allowCriticalAlerts: true,
        };

        // 2026-06-15 23:00 UTC -> 19:00 in NY (not quiet hours)
        const dateUtc2300 = new Date(Date.UTC(2026, 5, 15, 23, 0, 0));
        expect(isQuietHoursActive(config, dateUtc2300)).toBe(false);

        // 2026-06-16 03:00 UTC -> 23:00 in NY (is quiet hours!)
        const dateUtc0300 = new Date(Date.UTC(2026, 5, 16, 3, 0, 0));
        expect(isQuietHoursActive(config, dateUtc0300)).toBe(true);

        // 2026-06-16 11:30 UTC -> 07:30 in NY (is quiet hours!)
        const dateUtc1130 = new Date(Date.UTC(2026, 5, 16, 11, 30, 0));
        expect(isQuietHoursActive(config, dateUtc1130)).toBe(true);

        // 2026-06-16 12:00 UTC -> 08:00 in NY (quiet hours ended)
        const dateUtc1200 = new Date(Date.UTC(2026, 5, 16, 12, 0, 0));
        expect(isQuietHoursActive(config, dateUtc1200)).toBe(false);
      });

      it("correctly evaluates quiet hours in Asia/Tokyo (UTC+9)", () => {
        const config: QuietHoursConfig = {
          enabled: true,
          startTime: "23:00",
          endTime: "07:00",
          timezone: "Asia/Tokyo",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          allowCriticalAlerts: true,
        };

        // 2026-06-15 14:30 UTC -> 23:30 in Tokyo (quiet hours active)
        const dateUtc1430 = new Date(Date.UTC(2026, 5, 15, 14, 30, 0));
        expect(isQuietHoursActive(config, dateUtc1430)).toBe(true);

        // 2026-06-15 22:30 UTC -> 07:30 next day in Tokyo (quiet hours ended)
        const dateUtc2230 = new Date(Date.UTC(2026, 5, 15, 22, 30, 0));
        expect(isQuietHoursActive(config, dateUtc2230)).toBe(false);
      });
    });

    describe("Overnight day-of-week calendar invariants", () => {
      // Quiet hours configured only for Friday night (day 5) from 22:00 to 08:00
      const fridayOnlyConfig: QuietHoursConfig = {
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
        daysOfWeek: [5], // Friday only
        allowCriticalAlerts: true,
      };

      it("is active on Friday night (23:00 Friday)", () => {
        // 2026-06-19 is a Friday
        const fridayNight = new Date(Date.UTC(2026, 5, 19, 23, 0, 0));
        expect(isQuietHoursActive(fridayOnlyConfig, fridayNight)).toBe(true);
      });

      it("is active on Saturday early morning (04:00 Saturday) belonging to Friday night's session", () => {
        // 2026-06-20 is a Saturday
        const saturdayMorning = new Date(Date.UTC(2026, 5, 20, 4, 0, 0));
        expect(isQuietHoursActive(fridayOnlyConfig, saturdayMorning)).toBe(true);
      });

      it("is inactive on Saturday night (23:00 Saturday) because Saturday is not in schedule", () => {
        const saturdayNight = new Date(Date.UTC(2026, 5, 20, 23, 0, 0));
        expect(isQuietHoursActive(fridayOnlyConfig, saturdayNight)).toBe(false);
      });

      it("is inactive on Sunday morning (04:00 Sunday) because Saturday was not in schedule", () => {
        const sundayMorning = new Date(Date.UTC(2026, 5, 21, 4, 0, 0));
        expect(isQuietHoursActive(fridayOnlyConfig, sundayMorning)).toBe(false);
      });
    });

    describe("24-hour quiet window (startTime === endTime)", () => {
      const fullDayConfig: QuietHoursConfig = {
        enabled: true,
        startTime: "00:00",
        endTime: "00:00",
        timezone: "UTC",
        daysOfWeek: [0, 6], // Weekends only (Sun=0, Sat=6)
        allowCriticalAlerts: true,
      };

      it("is active all day on Saturday", () => {
        // 2026-06-20 is a Saturday
        expect(isQuietHoursActive(fullDayConfig, new Date(Date.UTC(2026, 5, 20, 0, 0, 0)))).toBe(true);
        expect(isQuietHoursActive(fullDayConfig, new Date(Date.UTC(2026, 5, 20, 12, 0, 0)))).toBe(true);
        expect(isQuietHoursActive(fullDayConfig, new Date(Date.UTC(2026, 5, 20, 23, 59, 0)))).toBe(true);
      });

      it("is inactive on Monday", () => {
        // 2026-06-22 is a Monday
        expect(isQuietHoursActive(fullDayConfig, new Date(Date.UTC(2026, 5, 22, 12, 0, 0)))).toBe(false);
      });
    });
  });

  describe("shouldSuppressNotification", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      startTime: "22:00",
      endTime: "08:00",
      timezone: "UTC",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      allowCriticalAlerts: true,
    };

    it("does not suppress when quiet hours is disabled", () => {
      const disabledConfig = { ...config, enabled: false };
      const decision = shouldSuppressNotification(disabledConfig, "productUpdates");
      expect(decision.suppress).toBe(false);
      expect(decision.reason).toBe("DISABLED");
    });

    it("does not suppress when current time is outside quiet hours", () => {
      const daytime = new Date(Date.UTC(2026, 5, 15, 14, 0, 0));
      const decision = shouldSuppressNotification(config, "streamStarted", daytime);
      expect(decision.suppress).toBe(false);
      expect(decision.reason).toBe("NOT_IN_QUIET_HOURS");
    });

    it("suppresses non-critical notifications during quiet hours and computes scheduledFor", () => {
      const nightTime = new Date(Date.UTC(2026, 5, 15, 23, 30, 0));
      const decision = shouldSuppressNotification(config, "productUpdates", nightTime);
      expect(decision.suppress).toBe(true);
      expect(decision.reason).toBe("QUIET_HOURS_ACTIVE");
      expect(decision.scheduledFor).toBeDefined();
      expect(decision.scheduledFor?.toISOString()).toBe("2026-06-16T08:00:00.000Z");
    });

    it("allows critical alerts to bypass quiet hours when allowCriticalAlerts is true", () => {
      const nightTime = new Date(Date.UTC(2026, 5, 15, 23, 30, 0));
      
      const settlementDecision = shouldSuppressNotification(config, "settlementFailed", nightTime);
      expect(settlementDecision.suppress).toBe(false);
      expect(settlementDecision.reason).toBe("CRITICAL_ALERT_BYPASS");

      const paymentDecision = shouldSuppressNotification(config, "paymentFailed", nightTime);
      expect(paymentDecision.suppress).toBe(false);
      expect(paymentDecision.reason).toBe("CRITICAL_ALERT_BYPASS");

      const streamCancelledDecision = shouldSuppressNotification(config, "streamCancelled", nightTime);
      expect(streamCancelledDecision.suppress).toBe(false);
      expect(streamCancelledDecision.reason).toBe("CRITICAL_ALERT_BYPASS");
    });

    it("suppresses critical alerts if user explicitly disabled allowCriticalAlerts", () => {
      const strictConfig = { ...config, allowCriticalAlerts: false };
      const nightTime = new Date(Date.UTC(2026, 5, 15, 23, 30, 0));

      const decision = shouldSuppressNotification(strictConfig, "settlementFailed", nightTime);
      expect(decision.suppress).toBe(true);
      expect(decision.reason).toBe("QUIET_HOURS_ACTIVE");
    });
  });

  describe("getNextQuietHoursEnd", () => {
    it("returns null if not in quiet hours or disabled", () => {
      const config: QuietHoursConfig = {
        ...DEFAULT_QUIET_HOURS,
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
      };

      const daytime = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
      expect(getNextQuietHoursEnd(config, daytime)).toBeNull();
      expect(getNextQuietHoursEnd({ ...config, enabled: false }, daytime)).toBeNull();
    });

    it("accurately finds the end of overnight quiet hours across midnight in UTC", () => {
      const config: QuietHoursConfig = {
        ...DEFAULT_QUIET_HOURS,
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
      };

      const nightTime = new Date(Date.UTC(2026, 5, 15, 23, 0, 0));
      const end = getNextQuietHoursEnd(config, nightTime);
      expect(end).not.toBeNull();
      expect(end?.toISOString()).toBe("2026-06-16T08:00:00.000Z");
    });

    it("accurately calculates end time in non-UTC timezone (America/New_York)", () => {
      const config: QuietHoursConfig = {
        ...DEFAULT_QUIET_HOURS,
        enabled: true,
        startTime: "22:00",
        endTime: "07:00",
        timezone: "America/New_York", // UTC-4 in June (EDT)
      };

      // 03:00 UTC = 23:00 NY time
      const nightTime = new Date(Date.UTC(2026, 5, 16, 3, 0, 0));
      const end = getNextQuietHoursEnd(config, nightTime);
      expect(end).not.toBeNull();
      // 07:00 EDT = 11:00 UTC
      expect(end?.toISOString()).toBe("2026-06-16T11:00:00.000Z");
    });
  });
});
