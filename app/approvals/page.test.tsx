import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import ApprovalsPage from "./page";
import { WALLET_ADDRESS_STORAGE_KEY } from "./useApprovals";
import { ToastProvider } from "@/app/components/ToastProvider";
import type { PendingApproval } from "@/app/lib/org-types";

expect.extend(toHaveNoViolations);

const OWNER = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const SETTLER = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "appr-1",
    streamId: "stream-ada",
    orgId: "org-acme",
    action: "settle",
    initiatedBy: OWNER,
    approvals: [OWNER],
    requiredCount: 2,
    status: "pending",
    createdAt: "2026-04-10T10:00:00.000Z",
    expiresAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <ApprovalsPage />
    </ToastProvider>,
  );
}

describe("ApprovalsPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, SETTLER);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("renders approvals grouped by status with matching tab counts and row details", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          makeApproval({ id: "appr-p1", streamId: "stream-ada", status: "pending" }),
          makeApproval({
            id: "appr-a1",
            streamId: "stream-bob",
            action: "stop",
            approvals: [OWNER, SETTLER],
            status: "approved",
          }),
          makeApproval({ id: "appr-r1", streamId: "stream-carol", status: "rejected" }),
        ],
      }),
    }) as jest.Mock;

    renderPage();

    const pendingTab = await screen.findByRole("tab", { name: "Pending (1)" });
    const approvedTab = screen.getByRole("tab", { name: "Approved (1)" });
    const rejectedTab = screen.getByRole("tab", { name: "Rejected (1)" });

    expect(pendingTab).toHaveAttribute("aria-selected", "true");
    expect(approvedTab).toHaveAttribute("aria-selected", "false");
    expect(rejectedTab).toHaveAttribute("aria-selected", "false");

    const row = screen.getByTestId("approval-row-appr-p1");
    const streamLink = within(row).getByRole("link", { name: "stream-ada" });
    expect(streamLink).toHaveAttribute("href", "/streams/stream-ada");
    expect(within(row).getByText("Settle")).toBeInTheDocument();
    expect(within(row).getByTestId("approval-votes-appr-p1")).toHaveTextContent("1 of 2");

    // Switch to Approved tab via keyboard
    fireEvent.keyDown(pendingTab, { key: "ArrowRight" });
    expect(approvedTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("approval-row-appr-a1")).toBeInTheDocument();
  });

  it("disables the vote button for approvals the connected wallet already voted on", async () => {
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, OWNER);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 })],
      }),
    }) as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Voted");
  });

  it("moves row to Approved and shows 'Threshold met' confirmation when thresholdMet is true", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });
    const approved = makeApproval({
      id: "appr-1",
      approvals: [OWNER, SETTLER],
      requiredCount: 2,
      status: "approved",
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: approved, meta: { thresholdMet: true } }),
      }) as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Pending (0)" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Approved (1)" })).toBeInTheDocument();
    });

    expect(screen.getByTestId("toast-item")).toHaveTextContent(/threshold met/i);
    expect(screen.getByTestId("approvals-live-region")).toHaveTextContent(/threshold met/i);
  });

  it("reverts optimistic update and shows error toast on 409 duplicate vote", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "VOTE_FAILED",
            message: "Actor has already cast an approval for this record.",
          },
        }),
      }) as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/you have already voted on this approval/i)).toBeInTheDocument();
    });

    // Optimistic count reverted back to 1 of 2
    expect(screen.getByTestId("approval-votes-appr-1")).toHaveTextContent("1 of 2");
  });

  it("reverts optimistic update and shows error toast on 403 permission error", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "VOTE_FAILED",
            message: "Role 'viewer' is not permitted to perform 'settle'.",
          },
        }),
      }) as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(
        screen.getByText(/organization role does not have permission/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("approval-votes-appr-1")).toHaveTextContent("1 of 2");
  });

  it("reverts optimistic update and shows error toast on 404 APPROVAL_NOT_FOUND", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            code: "APPROVAL_NOT_FOUND",
            message: "Approval 'appr-1' not found for stream 'stream-ada'.",
          },
        }),
      }) as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/could not be found/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId("approval-votes-appr-1")).toHaveTextContent("1 of 2");
  });

  it("sends exactly one request when double-clicking the vote button", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });
    let resolveVote!: (v: unknown) => void;
    const votePromise = new Promise((resolve) => {
      resolveVote = resolve;
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockReturnValueOnce(votePromise);
    global.fetch = fetchMock as jest.Mock;

    renderPage();

    const btn = await screen.findByRole("button", {
      name: /approve settle for stream stream-ada/i,
    });
    fireEvent.click(btn);
    fireEvent.click(btn);

    // 1 initial GET + 1 POST
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveVote({
      ok: true,
      json: async () => ({
        data: { ...initial, approvals: [OWNER, SETTLER], status: "approved" },
        meta: { thresholdMet: true },
      }),
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Approved (1)" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders empty state when there are zero approvals", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as jest.Mock;

    renderPage();

    expect(await screen.findByText(/no pending approvals/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pending (0)" })).toBeInTheDocument();
  });

  it("has no jest-axe accessibility violations", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [makeApproval({ id: "appr-1", status: "pending" })],
      }),
    }) as jest.Mock;

    const { container } = renderPage();
    await screen.findByTestId("approval-row-appr-1");

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
