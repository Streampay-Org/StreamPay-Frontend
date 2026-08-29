/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StatusBadge } from "./StatusBadge";
import { StreamRow, type StreamRowData } from "./StreamRow";
import { StreamProgress } from "./StreamProgress";
import { StickyStreamHeader } from "./StickyStreamHeader";
import { StreamEndedCard } from "./StreamEndedCard";
import { StreamDetailClient } from "../streams/[id]/StreamDetailClient";
import type { Stream, StreamStatus } from "@/app/types/openapi";

// Mock API client
jest.mock("../../lib/apiClient", () => ({
  fetchWithIdempotency: jest.fn().mockImplementation((url: string) => {
    if (url.includes("fail-trigger")) {
      const err = new Error("Network error") as any;
      err.isStreamPayError = true;
      err.retry = { retryable: true, backoffMs: 1000 };
      err.displayMessage = "Network failure";
      return Promise.reject(err);
    }
    return Promise.resolve({ ok: true });
  }),
}));

describe("Accessible Dashboard Status Semantics (Issue #1366)", () => {
  const lifecycleStatuses: readonly StreamStatus[] = [
    "active",
    "paused",
    "ended",
    "failed",
  ] as const;

  const mockStreams: Record<StreamStatus, StreamRowData> = {
    active: {
      id: "stream-active-1",
      recipient: "Alice Corp",
      rate: "100 XLM / month",
      schedule: "Pays monthly",
      status: "active",
      nextAction: "Pause",
      accruedAmount: 400,
      totalAmount: 1000,
    },
    paused: {
      id: "stream-paused-1",
      recipient: "Bob Services",
      rate: "50 XLM / week",
      schedule: "Pays weekly",
      status: "paused",
      nextAction: "Resume",
      accruedAmount: 200,
      totalAmount: 1000,
    },
    ended: {
      id: "stream-ended-1",
      recipient: "Charlie Design",
      rate: "25 XLM / day",
      schedule: "Ended yesterday",
      status: "ended",
      nextAction: "Withdraw",
      accruedAmount: 1000,
      totalAmount: 1000,
    },
    failed: {
      id: "stream-failed-1",
      recipient: "Dave Logistics",
      rate: "75 XLM / month",
      schedule: "Execution halted",
      status: "failed",
      nextAction: "Retry",
      accruedAmount: 150,
      totalAmount: 1000,
    },
    draft: {
      id: "stream-draft-1",
      recipient: "Eve Analytics",
      rate: "30 XLM / month",
      schedule: "Draft ready",
      status: "draft",
      nextAction: "Start",
    },
    withdrawn: {
      id: "stream-withdrawn-1",
      recipient: "Frank Audio",
      rate: "10 XLM / day",
      schedule: "Settled",
      status: "withdrawn",
      nextAction: "Details",
    },
    cancelled: {
      id: "stream-cancelled-1",
      recipient: "Grace Media",
      rate: "60 XLM / week",
      schedule: "Cancelled by sender",
      status: "cancelled",
      nextAction: "Details",
    },
  };

  describe("Criterion 1: All controls are keyboard operable", () => {
    it.each(lifecycleStatuses)(
      "action button in StreamRow is focusable and keyboard operable for status=%s",
      (status) => {
        render(<StreamRow stream={mockStreams[status]} />);
        const actionBtn = screen.getByRole("button", { name: mockStreams[status].nextAction });
        expect(actionBtn).toBeInTheDocument();
        expect(actionBtn).not.toBeDisabled();

        actionBtn.focus();
        expect(actionBtn).toHaveFocus();
      }
    );

    it("triggers action on button activation", async () => {
      const { fetchWithIdempotency } = require("../../lib/apiClient");
      render(<StreamRow stream={mockStreams.active} />);
      const actionBtn = screen.getByRole("button", { name: "Pause" });

      fireEvent.click(actionBtn);

      await waitFor(() => {
        expect(fetchWithIdempotency).toHaveBeenCalledWith(
          `/api/streams/${mockStreams.active.id}/pause`,
          expect.objectContaining({ method: "POST" })
        );
      });
    });

    it("StreamEndedCard action buttons are keyboard focusable and operable", () => {
      const onViewDetails = jest.fn();
      const onDismiss = jest.fn();
      render(
        <StreamEndedCard
          streamName="Marketing Stream"
          onViewDetails={onViewDetails}
          onDismiss={onDismiss}
        />
      );

      const viewDetailsBtn = screen.getByRole("button", { name: /view stream details/i });
      const dismissBtn = screen.getByRole("button", { name: /dismiss notification/i });

      viewDetailsBtn.focus();
      expect(viewDetailsBtn).toHaveFocus();
      fireEvent.click(viewDetailsBtn);
      expect(onViewDetails).toHaveBeenCalledTimes(1);

      dismissBtn.focus();
      expect(dismissBtn).toHaveFocus();
      fireEvent.click(dismissBtn);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("StreamProgress keyboard shortcuts toggle is keyboard accessible", () => {
      render(<StreamProgress status="active" accruedAmount={400} totalAmount={1000} />);
      const kbdToggle = screen.getByTestId("stream-progress-kbd-toggle");
      expect(kbdToggle).toBeInTheDocument();

      kbdToggle.focus();
      expect(kbdToggle).toHaveFocus();

      fireEvent.click(kbdToggle);
      expect(kbdToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("stream-progress-kbd-hints")).toBeInTheDocument();
    });
  });

  describe("Criterion 2: Status is conveyed in text (never color alone)", () => {
    it.each(lifecycleStatuses)(
      "StatusBadge displays status text and accessible role=status for status=%s",
      (status) => {
        render(<StatusBadge status={status} />);
        const badge = screen.getByRole("status");
        expect(badge).toBeInTheDocument();
        const capitalized = status.charAt(0).toUpperCase() + status.slice(1);
        expect(badge).toHaveTextContent(capitalized);
        expect(badge).toHaveAttribute("aria-label", `Stream status: ${capitalized}`);
      }
    );

    it.each(lifecycleStatuses)(
      "StreamRow displays textual status in metadata and badge for status=%s",
      (status) => {
        render(<StreamRow stream={mockStreams[status]} />);
        const statusMeta = screen.getByLabelText(`Stream status: ${status}`);
        expect(statusMeta).toBeInTheDocument();
        expect(statusMeta).toHaveTextContent(status);
      }
    );

    it.each(lifecycleStatuses)(
      "StickyStreamHeader conveys text status with role=status for status=%s",
      (status) => {
        render(
          <StickyStreamHeader
            streamId="stream-123"
            status={status}
            amount="500"
            assetCode="XLM"
            recipient="GABCD1234567890XYZ"
          />
        );
        const statusHeader = screen.getByRole("status");
        expect(statusHeader).toBeInTheDocument();
        expect(statusHeader).toHaveTextContent(status);
      }
    );

    it.each(lifecycleStatuses)(
      "StreamProgress provides descriptive aria-valuetext for status=%s",
      (status) => {
        render(<StreamProgress status={status} accruedAmount={400} totalAmount={1000} />);
        const progressBar = screen.getByRole("progressbar");
        expect(progressBar).toBeInTheDocument();
        expect(progressBar).toHaveAttribute("aria-valuetext");
        const valuetext = progressBar.getAttribute("aria-valuetext");
        expect(valuetext?.length).toBeGreaterThan(0);
      }
    );
  });

  describe("Criterion 3: Focus is visible and restored", () => {
    it("restores focus to action button after action completion", async () => {
      render(<StreamRow stream={mockStreams.active} />);
      const actionBtn = screen.getByRole("button", { name: "Pause" });

      actionBtn.focus();
      expect(actionBtn).toHaveFocus();

      fireEvent.click(actionBtn);

      await waitFor(() => {
        expect(actionBtn).toHaveFocus();
      });
    });

    it("restores focus to action button after action failure", async () => {
      const failingStream: StreamRowData = {
        ...mockStreams.active,
        nextAction: "fail-trigger",
      };
      render(<StreamRow stream={failingStream} />);
      const actionBtn = screen.getByRole("button", { name: "fail-trigger" });

      actionBtn.focus();
      expect(actionBtn).toHaveFocus();

      fireEvent.click(actionBtn);

      await waitFor(() => {
        expect(actionBtn).toHaveFocus();
      });
    });
  });

  describe("Criterion 4: Semantic landmarks and ARIA live regions", () => {
    it("StreamRow uses semantic <article> with aria-labelledby", () => {
      const { container } = render(<StreamRow stream={mockStreams.active} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toBeInTheDocument();
      expect(article).toHaveAttribute("aria-labelledby", "stream-active-1-recipient");
    });

    it("StickyStreamHeader carries semantic role=region and descriptive label", () => {
      render(
        <StickyStreamHeader
          streamId="stream-123"
          status="active"
          amount="250"
          assetCode="XLM"
          recipient="GABCD1234567890XYZ"
        />
      );
      const region = screen.getByRole("region", { name: /stream stream-123 summary/i });
      expect(region).toBeInTheDocument();
    });

    it("StreamEndedCard carries semantic role=region and role=status", () => {
      render(<StreamEndedCard streamName="Project Alpha" amount="1000" currency="USDC" />);
      expect(screen.getByRole("region", { name: /stream ended notification for Project Alpha/i })).toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Stream status: Ended" })).toBeInTheDocument();
    });

    it("StreamDetailClient announces lifecycle updates through live regions", async () => {
      const mockStreamDetail: Stream = {
        id: "stream-test-detail",
        recipient: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2Z",
        rate: "100 XLM / month",
        schedule: "Monthly",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      window.alert = jest.fn();
      render(<StreamDetailClient stream={mockStreamDetail} />);
      const pauseBtn = screen.getByRole("button", { name: /pause stream stream-test-detail/i });
      expect(pauseBtn).toBeInTheDocument();

      fireEvent.click(pauseBtn);

      await waitFor(() => {
        const statuses = screen.getAllByRole("status");
        expect(statuses.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Criterion 5: Coverage across active, paused, ended, and failed states", () => {
    it.each(lifecycleStatuses)(
      "renders complete status lifecycle representation without error for status=%s",
      (status) => {
        const { container } = render(
          <div>
            <StatusBadge status={status} />
            <StreamRow stream={mockStreams[status]} />
            <StreamProgress status={status} accruedAmount={300} totalAmount={1000} />
            <StickyStreamHeader
              streamId={`stream-${status}`}
              status={status}
              amount="300"
              recipient="GABCD1234567890XYZ"
            />
          </div>
        );

        expect(container).toBeInTheDocument();
        expect(container.querySelectorAll(".cb-pattern").length).toBeGreaterThan(0);
      }
    );
  });
});
