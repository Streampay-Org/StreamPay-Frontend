/**
 * @jest-environment jsdom
 */
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ReconciliationOpsPage, {
  AUTO_REFRESH_MS,
  buildRunsUrl,
  formatAmount,
  parseRetryAfter,
} from "./page";
import { ADMIN_CREDENTIAL_STORAGE_KEY } from "./admin-credential";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CHECKED_AT = "2026-01-03T00:00:00.000Z";

const healthOk = {
  status: "ok",
  checks: {
    database: { status: "ok", checked_at: CHECKED_AT },
    onchain: { status: "ok", checked_at: CHECKED_AT },
  },
};

const runOne = {
  id: "rec-pub-1",
  // 2^53 + 1 — must survive formatting without precision loss.
  totalReconciled: "9007199254740993",
  currency: "XLM",
  status: "completed",
  created_at: "2026-01-03T00:00:00.000Z",
};

const runTwo = {
  id: "rec-pub-2",
  totalReconciled: "300",
  currency: "USDC",
  status: "pending",
  created_at: "2026-01-02T00:00:00.000Z",
};

const pageOne = {
  status: "success",
  data: [runOne, runTwo],
  meta: { total: 3, limit: 20, hasNext: true, nextCursor: "cursor-2" },
};

const pageTwo = {
  status: "success",
  data: [
    {
      id: "rec-pub-3",
      totalReconciled: "250",
      currency: "USDC",
      status: "failed",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  meta: { total: 1, limit: 20, hasNext: false, nextCursor: null },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchMock {
  const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as FetchMock;
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function reconciliationCalls(mock: FetchMock) {
  return mock.mock.calls.filter(([input]) =>
    String(input).startsWith("/api/reconciliation?"),
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("reconciliation dashboard helpers", () => {
  it("formats bigint-like strings without precision loss", () => {
    expect(formatAmount("9007199254740993")).toBe("900719925.4740993");
    expect(formatAmount(1500)).toBe("0.0001500");
  });

  it("leaves non-numeric field values untouched", () => {
    expect(formatAmount("exists")).toBe("exists");
    expect(formatAmount("missing")).toBe("missing");
  });

  it("parses Retry-After delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter(null)).toBe(AUTO_REFRESH_MS / 1000);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds)).toBeGreaterThanOrEqual(9);
  });

  it("builds the runs URL with cursor and status", () => {
    expect(buildRunsUrl({ limit: 20, cursor: "abc", status: "failed" })).toBe(
      "/api/reconciliation?limit=20&cursor=abc&status=failed",
    );
    expect(buildRunsUrl({ limit: 20 })).toBe("/api/reconciliation?limit=20");
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("ReconciliationOpsPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders the last run, health cards and the discrepancy table", async () => {
    installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);

    expect(
      screen.getByRole("heading", { name: "Reconciliation" }),
    ).toBeInTheDocument();

    // Last run summary (latest row is first).
    const lastRun = screen.getByRole("region", { name: /last run/i });
    await waitFor(() => {
      expect(within(lastRun).getByText("rec-pub-1")).toBeInTheDocument();
    });

    // Health cards state both colour and text.
    const health = screen.getByRole("region", { name: /health checks/i });
    expect(within(health).getByText("Database")).toBeInTheDocument();
    expect(within(health).getByText("On-chain")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(health).getAllByText(/healthy/i)).toHaveLength(2);
    });

    // Table with bigint-safe amount formatting and status chips.
    const table = screen.getByRole("table", {
      name: /reconciliation runs/i,
    });
    await waitFor(() => {
      expect(within(table).getByText("900719925.4740993")).toBeInTheDocument();
    });
    expect(within(table).getByText("completed")).toBeInTheDocument();
    expect(within(table).getByText("pending")).toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", async () => {
    installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      return jsonResponse({ status: "success", data: [], meta: { hasNext: false, nextCursor: null } });
    });

    render(<ReconciliationOpsPage />);

    expect(
      await screen.findByText(/no reconciliation runs found/i),
    ).toBeInTheDocument();
  });

  it("renders a degraded banner and degraded check text for a 503 health response", async () => {
    installFetch((url) => {
      if (url === "/api/reconciliation/health") {
        return jsonResponse(
          {
            status: "degraded",
            checks: {
              database: {
                status: "degraded",
                message: "reconciliation database dependency is not ready",
                checked_at: CHECKED_AT,
              },
              onchain: { status: "ok", checked_at: CHECKED_AT },
            },
          },
          503,
        );
      }
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);

    expect(
      await screen.findByText(/reconciliation health is degraded/i),
    ).toBeInTheDocument();

    const health = screen.getByRole("region", { name: /health checks/i });
    expect(within(health).getByText("Degraded")).toBeInTheDocument();
    expect(within(health).getByText("Healthy")).toBeInTheDocument();
    expect(
      within(health).getByText(/database dependency is not ready/i),
    ).toBeInTheDocument();
    // A 503 is not reported as a generic fetch failure.
    expect(screen.queryByText(/health check unavailable/i)).not.toBeInTheDocument();
  });

  it("appends the next page when Load more is pressed", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      if (url.includes("cursor=cursor-2")) return jsonResponse(pageTwo);
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);
    await screen.findByText("rec-pub-2");

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("rec-pub-3")).toBeInTheDocument();
    // Previous rows are kept.
    expect(screen.getAllByText("rec-pub-1").length).toBeGreaterThan(0);
    expect(
      reconciliationCalls(fetchMock).some(([input]) => String(input).includes("cursor=cursor-2")),
    ).toBe(true);
  });

  it("resets to the first page when the cursor is rejected with INVALID_CURSOR", async () => {
    let firstPageRequests = 0;
    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      if (url.includes("cursor=stale")) {
        return jsonResponse(
          { error: { code: "INVALID_CURSOR", message: "Query param cursor is malformed." } },
          422,
        );
      }
      firstPageRequests += 1;
      if (firstPageRequests === 1) {
        return jsonResponse({
          ...pageOne,
          meta: { ...pageOne.meta, nextCursor: "stale" },
        });
      }
      return jsonResponse({
        status: "success",
        data: [runTwo],
        meta: { total: 1, limit: 20, hasNext: false, nextCursor: null },
      });
    });

    render(<ReconciliationOpsPage />);
    await screen.findAllByText("rec-pub-1");

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => {
      expect(screen.queryAllByText("rec-pub-1")).toHaveLength(0);
    });
    expect(screen.getAllByText("rec-pub-2").length).toBeGreaterThan(0);

    const calls = reconciliationCalls(fetchMock).map(([input]) => String(input));
    expect(calls.some((url) => url.includes("cursor=stale"))).toBe(true);
    // The reset request goes back to the first page (no cursor).
    expect(calls[calls.length - 1]).toBe("/api/reconciliation?limit=20");
  });

  it("pauses polling and shows a countdown when the API returns 429", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      return jsonResponse(
        { error: { code: "rate_limit_exceeded", message: "Too many requests" } },
        429,
        { "Retry-After": "12" },
      );
    });

    render(<ReconciliationOpsPage />);

    expect(
      await screen.findByText(/auto-refresh is paused/i),
    ).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();

    const callsAfterRateLimit = fetchMock.mock.calls.length;
    // Auto-refresh stays paused while the countdown is active.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterRateLimit);
    expect(screen.getByText(/^1[01]s$/)).toBeInTheDocument();
  });

  it("refreshes at most once every 30 seconds", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      return jsonResponse(pageOne);
    });
    const setIntervalSpy = jest.spyOn(global, "setInterval");

    render(<ReconciliationOpsPage />);
    await screen.findAllByText("rec-pub-1");

    // The polling interval is registered for AUTO_REFRESH_MS, never shorter.
    const intervals = setIntervalSpy.mock.calls.map(([, delay]) => delay);
    expect(AUTO_REFRESH_MS).toBe(30_000);
    expect(intervals).toContain(AUTO_REFRESH_MS);

    const before = fetchMock.mock.calls.length;
    const refresh = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === AUTO_REFRESH_MS,
    )?.[0] as () => void;
    await act(async () => {
      refresh();
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("shows an accurate field-by-field diff and flags mismatches", async () => {
    window.sessionStorage.setItem(ADMIN_CREDENTIAL_STORAGE_KEY, "admin-token-123");

    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      if (url.startsWith("/api/reconciliation/diff/")) {
        return jsonResponse({
          data: {
            streamId: "rec-pub-1",
            checkedAt: CHECKED_AT,
            inSync: false,
            diffs: [
              {
                field: "released_amount",
                dbValue: "9007199254740993",
                onChainValue: "1100000000",
                toleranceApplied: true,
              },
            ],
          },
        });
      }
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);
    await screen.findAllByText("rec-pub-1");

    await userEvent.click(
      screen.getByRole("button", { name: /view diff for rec-pub-1/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/1 mismatched field/i),
    ).toBeInTheDocument();

    const table = within(dialog).getByRole("table");
    expect(within(table).getByText("released_amount")).toBeInTheDocument();
    expect(within(table).getByText("900719925.4740993")).toBeInTheDocument();
    expect(within(table).getByText("110.0000000")).toBeInTheDocument();
    expect(within(table).getByText("Applied")).toBeInTheDocument();

    const diffCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/reconciliation/diff/"),
    );
    expect(diffCall).toBeDefined();
    const headers = diffCall?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer admin-token-123");
  });

  it("reports admin authorization failures in the diff drawer", async () => {
    window.sessionStorage.setItem(ADMIN_CREDENTIAL_STORAGE_KEY, "wrong-token");

    installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      if (url.startsWith("/api/reconciliation/diff/")) {
        return jsonResponse(
          { error: { code: "Unauthorized", message: "Only the admin may perform this operation." } },
          403,
        );
      }
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);
    await screen.findAllByText("rec-pub-1");

    await userEvent.click(
      screen.getByRole("button", { name: /view diff for rec-pub-1/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/admin authorization required/i),
    ).toBeInTheDocument();
  });

  it("does not request a diff without an admin credential", async () => {
    const fetchMock = installFetch((url) => {
      if (url === "/api/reconciliation/health") return jsonResponse(healthOk);
      return jsonResponse(pageOne);
    });

    render(<ReconciliationOpsPage />);
    await screen.findAllByText("rec-pub-1");

    await userEvent.click(
      screen.getByRole("button", { name: /view diff for rec-pub-1/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/add an admin credential/i),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/reconciliation/diff/")),
    ).toBe(false);
  });
});
