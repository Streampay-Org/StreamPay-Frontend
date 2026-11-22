/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ExportJob } from "@/app/types/openapi";
import { useExportJobs } from "./useExportJobs";

function makeJob(overrides: Partial<ExportJob> = {}): ExportJob {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: "job-1",
    ownerId: "GTESTWALLET",
    requestedAt: now,
    status: "pending",
    expiresAt: future,
    fileName: "streampay-export-2026-11-23.csv",
    rows: 0,
    ...overrides,
  };
}

function mockJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  } as unknown as Response;
}

function mockEmptyResponse(
  status: number,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => {
      throw new Error("No body");
    },
  } as unknown as Response;
}

describe("useExportJobs", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sends If-None-Match on subsequent polls, treats 304 as no change, and stops when no job is pending", async () => {
    const pendingJob = makeJob({ id: "job-1", status: "pending" });
    const readyJob = makeJob({
      id: "job-1",
      status: "ready",
      signedUrl: "/api/exports/job-1?download=true&expires=2026-11-30&sig=abc",
    });

    let currentEtag = '"etag-v1"';
    let currentJobs = [pendingJob];

    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["If-None-Match"] === currentEtag) {
        return mockEmptyResponse(304, { ETag: currentEtag });
      }
      return mockJsonResponse(
        { data: currentJobs },
        { status: 200, headers: { ETag: currentEtag } }
      );
    });

    const { result } = renderHook(() => useExportJobs({ pollIntervalMs: 2000 }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.jobs).toEqual([pendingJob]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First poll: ETag unchanged -> 304
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "If-None-Match": '"etag-v1"',
    });
    expect(result.current.jobs).toEqual([pendingJob]);

    // Transition job to ready with a new ETag
    currentEtag = '"etag-v2"';
    currentJobs = [readyJob];

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await waitFor(() => expect(result.current.jobs[0].status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // No pending jobs remain -> polling stops
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("backs off on errors and stops polling when tab is hidden", async () => {
    const pendingJob = makeJob({ id: "job-1", status: "pending" });

    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse({ data: [pendingJob] }, { status: 200, headers: { ETag: '"e1"' } })
      )
      .mockResolvedValueOnce(
        mockJsonResponse({ error: { message: "Server busy" } }, { status: 500 })
      )
      .mockResolvedValueOnce(mockEmptyResponse(304, { ETag: '"e1"' }));

    const { result } = renderHook(() =>
      useExportJobs({ pollIntervalMs: 1000, maxBackoffMs: 10000 })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First poll after 1000ms -> 500 error, next backoff should be 2000ms
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toContain("Server busy");

    // At +1000ms, should NOT have polled yet due to 2000ms backoff
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // At +2000ms total, polls again and succeeds with 304
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();

    // Hide tab -> stops polling
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cleans up all timers on unmount during poll", async () => {
    const pendingJob = makeJob({ id: "job-1", status: "pending" });
    fetchMock.mockResolvedValue(
      mockJsonResponse({ data: [pendingJob] }, { status: 200, headers: { ETag: '"e1"' } })
    );

    const { result, unmount } = renderHook(() =>
      useExportJobs({ pollIntervalMs: 2000 })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("shows specific messages for 401, 422, and 429 with Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ error: { message: "Unauthorized" } }, { status: 401 })
    );

    const { result } = renderHook(() => useExportJobs());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toMatch(/401/);

    // 422 on POST
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ error: { message: "Bad date range" } }, { status: 422 })
    );
    await act(async () => {
      await result.current.requestExport({ format: "csv" });
    });
    expect(result.current.submitError).toMatch(/422/);
    expect(result.current.submitError).toContain("Bad date range");

    // 429 on POST with Retry-After: 5
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        { error: { message: "Too many requests" } },
        { status: 429, headers: { "Retry-After": "5" } }
      )
    );
    await act(async () => {
      await result.current.requestExport({ format: "json" });
    });
    expect(result.current.submitError).toMatch(/429/);
    expect(result.current.isRateLimited).toBe(true);
    expect(result.current.rateLimitSecondsLeft).toBe(5);

    // Advance 5 seconds -> cooldown clears
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(result.current.isRateLimited).toBe(false);
    expect(result.current.rateLimitSecondsLeft).toBe(0);
  });
});
