/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AuditPage from "./page";
import { AuditResponseSchema, type AuditResponseDTO } from "@/app/lib/dtos/audit.dto";
import type { AuditEntry } from "@/app/types/audit";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "audit-1",
    actor: { id: "ops-admin-42", role: "admin" },
    target: { type: "stream", id: "stream-ada", account: "acct_12345678" },
    action: "stream.settle",
    beforeHash: "hash-before",
    afterHash: "hash-after",
    diffHash: "hash-diff",
    requestId: "req-1001",
    timestamp: "2026-04-28T12:00:00.000Z",
    prevHash: null,
    entryHash: "entry-hash-1",
    retentionUntil: "2026-05-28T12:00:00.000Z",
    metadata: { reason: "scheduled", amount: 500 },
    ...overrides,
  };
}

function makePayload(overrides: Partial<AuditResponseDTO> = {}): AuditResponseDTO {
  const payload: AuditResponseDTO = {
    access: { actorId: "comp-1", role: "compliance" },
    data: [makeEntry()],
    links: { self: "/api/audit" },
    meta: {
      chainIntact: true,
      retentionDays: 30,
      total: 1,
      hasNext: false,
      nextCursor: null,
    },
    ...overrides,
  };
  return AuditResponseSchema.parse(payload);
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

describe("AuditPage (/audit)", () => {
  const originalFetch = global.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    window.history.replaceState(null, "", "/audit");
    global.fetch = jest.fn();
    URL.createObjectURL = jest.fn(() => "blob:mock-url");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    jest.restoreAllMocks();
  });

  it("loads audit entries, renders table rows, and announces count via LiveRegion", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(makePayload()),
    );

    render(<AuditPage />);

    expect(await screen.findByText("ops-admin-42")).toBeInTheDocument();
    expect(screen.getByText("stream.settle")).toBeInTheDocument();
    expect(screen.getByText("req-1001")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1 of 1 audit log entries.",
    );
  });

  it("updates request query and URL when filters change and resets cleanly", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockJsonResponse(makePayload()),
    );

    render(<AuditPage />);
    await screen.findByText("ops-admin-42");

    fireEvent.change(screen.getByLabelText("Actor ID"), {
      target: { value: "sec-9" },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "security" },
    });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-04-01" },
    });

    await waitFor(() => {
      expect(window.location.search).toContain("actorId=sec-9");
      expect(window.location.search).toContain("role=security");
      expect(window.location.search).toContain("startDate=2026-04-01");
    });

    const lastCallUrl = (global.fetch as jest.Mock).mock.calls.at(-1)?.[0] as string;
    expect(lastCallUrl).toContain("actorId=sec-9");
    expect(lastCallUrl).toContain("role=security");
    expect(lastCallUrl).toContain("startDate=2026-04-01T00%3A00%3A00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(screen.getByLabelText("Actor ID")).toHaveValue("");
    expect(screen.getByLabelText("Role")).toHaveValue("");
  });

  it("appends rows without duplicates on cursor paging and hides Load more when hasNext is false", async () => {
    const entry1 = makeEntry({ id: "audit-1", requestId: "req-1" });
    const entry2 = makeEntry({ id: "audit-2", requestId: "req-2" });

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockJsonResponse(
          makePayload({
            data: [entry1],
            meta: {
              chainIntact: true,
              retentionDays: 30,
              total: 2,
              hasNext: true,
              nextCursor: "Y3Vyc29yLTE=",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          makePayload({
            data: [entry1, entry2],
            meta: {
              chainIntact: true,
              retentionDays: 30,
              total: 2,
              hasNext: false,
              nextCursor: null,
            },
          }),
        ),
      );

    render(<AuditPage />);
    await screen.findByText("req-1");

    const loadMoreBtn = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMoreBtn);

    await screen.findByText("req-2");
    expect(screen.getAllByText("req-1")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("displays a prominent banner when chainIntact is false", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        makePayload({
          meta: {
            chainIntact: false,
            retentionDays: 30,
            total: 1,
            hasNext: false,
            nextCursor: null,
          },
        }),
      ),
    );

    render(<AuditPage />);
    const banner = await screen.findByTestId("chain-integrity-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/chainIntact: false/i);
  });

  it("expands very long metadata JSON when toggled", async () => {
    const longValue = "x".repeat(2000);
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        makePayload({
          data: [makeEntry({ metadata: { payload: longValue } })],
        }),
      ),
    );

    render(<AuditPage />);
    const toggleBtn = await screen.findByRole("button", { name: "View JSON" });
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(new RegExp(longValue.slice(0, 64)))).toBeInTheDocument();
  });

  it("exports CSV with active filters and downloads archive; shows error on 403 without saving a blank file", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJsonResponse(makePayload()))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => new Blob(["id,action\naudit-1,stream.settle\n"], { type: "text/csv" }),
      } as unknown as Response)
      .mockResolvedValueOnce(
        mockJsonResponse(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          403,
        ),
      );

    render(<AuditPage />);
    await screen.findByText("ops-admin-42");

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });
    const exportUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string;
    expect(exportUrl).toContain("/api/audit/export?format=csv");

    fireEvent.click(screen.getByRole("button", { name: "Download archive" }));
    expect(
      await screen.findByText(/Archive download forbidden/i),
    ).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("shows an explanatory forbidden state on 403 from /api/audit", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        { error: { code: "FORBIDDEN", message: "Forbidden" } },
        403,
      ),
    );

    render(<AuditPage />);
    expect(
      await screen.findByRole("heading", { name: "Audit Log Access Restricted" }),
    ).toBeInTheDocument();
  });

  it("handles 422 INVALID_CURSOR and empty result states", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockJsonResponse(
          { error: { code: "INVALID_CURSOR", message: "Malformed cursor" } },
          422,
        ),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          makePayload({
            data: [],
            meta: {
              chainIntact: true,
              retentionDays: 30,
              total: 0,
              hasNext: false,
              nextCursor: null,
            },
          }),
        ),
      );

    render(<AuditPage />);
    expect(
      await screen.findByText(/Invalid pagination cursor: Malformed cursor/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText(
        "No audit log entries found for the selected filters.",
      ),
    ).toBeInTheDocument();
  });
});
