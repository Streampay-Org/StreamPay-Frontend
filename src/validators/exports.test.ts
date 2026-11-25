import { validateExportRequest } from "./exports";

describe("validateExportRequest", () => {
  describe("format", () => {
    it("defaults to csv for an empty body", () => {
      const result = validateExportRequest({});
      expect(result).toEqual({ success: true, data: { format: "csv" } });
    });

    it("accepts csv", () => {
      const result = validateExportRequest({ format: "csv" });
      expect(result).toEqual({ success: true, data: { format: "csv" } });
    });

    it("accepts json", () => {
      const result = validateExportRequest({ format: "json" });
      expect(result).toEqual({ success: true, data: { format: "json" } });
    });

    it("rejects xml", () => {
      const result = validateExportRequest({ format: "xml" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("format");
        expect(typeof result.errors[0].code).toBe("string");
        expect(result.errors[0].message).toBeTruthy();
      }
    });

    it("rejects uppercase CSV", () => {
      const result = validateExportRequest({ format: "CSV" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("format");
      }
    });

    it("rejects a non-string format", () => {
      const result = validateExportRequest({ format: 123 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("format");
        expect(result.errors[0].code).toBe("INVALID_TYPE");
      }
    });
  });

  describe("unknown fields and body shape", () => {
    it("rejects unknown fields with UNRECOGNIZED_KEYS and the custom message", () => {
      const result = validateExportRequest({ format: "csv", extra: true });
      expect(result).toEqual({
        success: false,
        errors: [
          {
            field: "body",
            code: "UNRECOGNIZED_KEYS",
            message: "Unknown fields are not allowed.",
          },
        ],
      });
    });

    it.each([
      ["null", null],
      ["an array", []],
      ["a string", "csv"],
    ])("rejects %s as a body with field 'body'", (_label, body) => {
      const result = validateExportRequest(body);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("body");
        expect(result.errors[0].code).toBe("INVALID_TYPE");
      }
    });
  });

  describe("date filters", () => {
    it("accepts valid ISO datetimes with Z", () => {
      const body = {
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-01-31T23:59:59Z",
      };
      const result = validateExportRequest(body);
      expect(result).toEqual({ success: true, data: { format: "csv", ...body } });
    });

    it("accepts startDate on its own", () => {
      const result = validateExportRequest({ startDate: "2026-01-01T00:00:00Z" });
      expect(result.success).toBe(true);
    });

    it("rejects a date-only string", () => {
      const result = validateExportRequest({ startDate: "2026-01-01" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("startDate");
      }
    });

    it("rejects an invalid date string for endDate", () => {
      const result = validateExportRequest({ endDate: "not-a-date" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("endDate");
      }
    });

    it("rejects an invalid startDate string with field 'startDate'", () => {
      const result = validateExportRequest({ startDate: "not-a-date" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("startDate");
      }
    });

    it("rejects a datetime with an offset (+02:00) by default", () => {
      const result = validateExportRequest({ startDate: "2026-01-01T00:00:00+02:00" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe("startDate");
      }
    });

    it("rejects startDate after endDate with the cross-field error", () => {
      const result = validateExportRequest({
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-01-01T00:00:00Z",
      });
      expect(result).toEqual({
        success: false,
        errors: [
          {
            field: "startDate",
            code: "CUSTOM",
            message: "startDate must be on or before endDate",
          },
        ],
      });
    });

    it("accepts startDate equal to endDate", () => {
      const result = validateExportRequest({
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-01-01T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });
  });
});
