/**
 * @jest-environment jsdom
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExportJob } from "@/app/types/openapi";
import { ExportsPageContent } from "./page";

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
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
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

describe("ExportsPageContent", () => {
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

  it("shows a new export immediately as pending and transitions to ready without manual refresh", async () => {
    const pendingJob = makeJob({ id: "job-new", status: "pending" });
    const readyJob = makeJob({
      id: "job-new",
      status: "ready",
      signedUrl: "/api/exports/job-new?download=true&expires=2026-11-30&sig=xyz",
    });

    let getCount = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return mockJsonResponse({ data: pendingJob }, { status: 201 });
      }
      getCount += 1;
      if (getCount === 1) {
        return mockJsonResponse(
          { data: [] },
          { status: 200, headers: { ETag: '"e0"' } }
        );
      }
      if (getCount === 2) {
        return mockEmptyResponse(304, { ETag: '"e0"' });
      }
      return mockJsonResponse(
        { data: [readyJob] },
        { status: 200, headers: { ETag: '"e1"' } }
      );
    });

    render(<ExportsPageContent />);

    await waitFor(() =>
      expect(screen.getByText(/No export jobs yet/i)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Request export" }));

    // Immediately appears as Pending
    await waitFor(() =>
      expect(screen.getByLabelText("Export status: Pending")).toBeInTheDocument()
    );

    // Poll 1 -> 304
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByLabelText("Export status: Pending")).toBeInTheDocument();

    // Poll 2 -> ready
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Export status: Ready")).toBeInTheDocument()
    );

    const downloadLink = screen.getByRole("link", { name: "Download" });
    expect(downloadLink).toHaveAttribute("href", readyJob.signedUrl);
  });

  it("validates inverted date ranges client-side without submitting", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ data: [] }, { status: 200, headers: { ETag: '"e0"' } })
    );

    render(<ExportsPageContent />);
    await waitFor(() =>
      expect(screen.getByText(/No export jobs yet/i)).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-11-20" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-11-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request export" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Start date must be on or before end date."
    );
    // Only the initial GET was called, no POST
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hides the download button and shows Expired when a job expires while the page is open", async () => {
    const expiresSoon = new Date(Date.now() + 5_000).toISOString();
    const readyJob = makeJob({
      id: "job-expiring",
      status: "ready",
      expiresAt: expiresSoon,
      signedUrl: "/api/exports/job-expiring?download=true&expires=soon&sig=123",
    });

    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        { data: [readyJob] },
        { status: 200, headers: { ETag: '"e1"' } }
      )
    );

    render(<ExportsPageContent />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download" })).toBeInTheDocument()
    );
    expect(screen.getByLabelText("Export status: Ready")).toBeInTheDocument();

    // Advance past expiresAt
    await act(async () => {
      jest.advanceTimersByTime(6_000);
    });

    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Export status: Expired")).toBeInTheDocument();
    expect(screen.getByLabelText("Export expired")).toHaveTextContent("Expired");
  });

  it("retries failed jobs and disables buttons on 429 until Retry-After passes", async () => {
    const failedJob = makeJob({
      id: "job-failed",
      status: "failed",
      fileName: "streampay-export-2026-11-23.json",
    });
    const retriedJob = makeJob({
      id: "job-retried",
      status: "pending",
      fileName: "streampay-export-2026-11-23.json",
    });

    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(
          { data: [failedJob] },
          { status: 200, headers: { ETag: '"e1"' } }
        )
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          { error: { message: "Rate limit exceeded" } },
          { status: 429, headers: { "Retry-After": "4" } }
        )
      )
      .mockResolvedValueOnce(
        mockJsonResponse({ data: retriedJob }, { status: 201 })
      );

    render(<ExportsPageContent />);

    await waitFor(() =>
      expect(screen.getByLabelText("Export status: Failed")).toBeInTheDocument()
    );

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    // 429 disables submit and retry buttons
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/429/)
    );
    expect(retryButton).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Retry in 4s/i })
    ).toBeDisabled();

    // Advance 4 seconds -> cooldown expires and buttons re-enable
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });

    expect(retryButton).not.toBeDisabled();

    // Retry again -> succeeds and creates a new pending job
    fireEvent.click(retryButton);
    await waitFor(() =>
      expect(screen.getByLabelText("Export status: Pending")).toBeInTheDocument()
    );
  });

  it("does not leak timers after unmount during polling", async () => {
    const pendingJob = makeJob({ id: "job-pending", status: "pending" });
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { data: [pendingJob] },
        { status: 200, headers: { ETag: '"e1"' } }
      )
    );

    const { unmount } = render(<ExportsPageContent />);
    await waitFor(() =>
      expect(screen.getByLabelText("Export status: Pending")).toBeInTheDocument()
    );

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
