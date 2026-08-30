/**
 * Unit tests for the mutation confirmation guard (Issue #1449).
 *
 * `extractConfirmedStreamStatus` is the fail-closed gate: a success is only
 * ever presented when the mutation response carries the freshly-persisted
 * `data.status` from the server. Everything else must resolve to "not
 * confirmed" so offline/stale requests can never surface as a false success.
 */

import {
  createOfflineMutationError,
  createUnconfirmedMutationError,
  extractConfirmedStreamStatus,
} from "./mutation-confirm";

describe("extractConfirmedStreamStatus", () => {
  it("returns the status for a confirmed mutation payload", () => {
    expect(extractConfirmedStreamStatus({ data: { status: "paused" } })).toBe(
      "paused",
    );
  });

  it("returns the status for payloads with extra fields (settle/withdraw)", () => {
    expect(
      extractConfirmedStreamStatus({
        alert: null,
        data: { status: "ended", nextAction: "withdraw" },
        withdrawal: { state: "pending" },
      }),
    ).toBe("ended");
  });

  it("returns null for non-object bodies", () => {
    expect(extractConfirmedStreamStatus(null)).toBeNull();
    expect(extractConfirmedStreamStatus(undefined)).toBeNull();
    expect(extractConfirmedStreamStatus("ok")).toBeNull();
    expect(extractConfirmedStreamStatus(true)).toBeNull();
    expect(extractConfirmedStreamStatus(42)).toBeNull();
  });

  it("returns null when the data payload is missing", () => {
    expect(extractConfirmedStreamStatus({ ok: true })).toBeNull();
    expect(extractConfirmedStreamStatus({})).toBeNull();
  });

  it("returns null when status is absent or empty", () => {
    expect(extractConfirmedStreamStatus({ data: {} })).toBeNull();
    expect(extractConfirmedStreamStatus({ data: { status: "" } })).toBeNull();
    expect(extractConfirmedStreamStatus({ data: { status: 5 } })).toBeNull();
    expect(extractConfirmedStreamStatus({ data: null })).toBeNull();
  });
});

describe("createOfflineMutationError", () => {
  it("is a retryable network error", () => {
    const err = createOfflineMutationError();
    expect(err.code).toBe("NETWORK_UNAVAILABLE");
    expect(err.category).toBe("network");
    expect(err.retry.retryable).toBe(true);
  });

  it("states explicitly that the action was not applied", () => {
    const err = createOfflineMutationError();
    expect(err.detail.toLowerCase()).toContain("not applied");
  });
});

describe("createUnconfirmedMutationError", () => {
  it("is a fail-closed error that names the failed action", () => {
    const err = createUnconfirmedMutationError("Pause");
    expect(err.title).toBe("Action not confirmed");
    expect(err.detail).toContain("Pause");
    expect(err.retry.retryable).toBe(true);
  });
});