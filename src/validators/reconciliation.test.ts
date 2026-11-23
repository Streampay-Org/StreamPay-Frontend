/**
 * @jest-environment node
 */

import { validateReconciliationQuery } from "./reconciliation";

describe("validateReconciliationQuery (Issue #1136)", () => {
  it("accepts an empty query and returns defaults-ready data", () => {
    const result = validateReconciliationQuery({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.limit).toBeUndefined();
      expect(result.data.cursor).toBeUndefined();
      expect(result.data.status).toBeUndefined();
    }
  });

  it("parses a valid limit integer string", () => {
    const result = validateReconciliationQuery({ limit: "50" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("rejects a non-integer limit", () => {
    const result = validateReconciliationQuery({ limit: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].field).toBe("limit");
      expect(result.errors[0].message).toMatch(/integer between 1 and 1000/i);
    }
  });

  it("rejects a limit outside 1–1000", () => {
    const tooLow = validateReconciliationQuery({ limit: "0" });
    const tooHigh = validateReconciliationQuery({ limit: "1001" });
    expect(tooLow.ok).toBe(false);
    expect(tooHigh.ok).toBe(false);
  });

  it("rejects an empty cursor string", () => {
    const result = validateReconciliationQuery({ cursor: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "cursor")).toBe(true);
    }
  });

  it("accepts a known status enum value", () => {
    const result = validateReconciliationQuery({ status: "completed" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("completed");
    }
  });

  it("rejects an unknown status", () => {
    const result = validateReconciliationQuery({ status: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "status")).toBe(true);
    }
  });
});
