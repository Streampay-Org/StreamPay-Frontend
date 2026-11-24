/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { Stream, StreamStatus } from "../types/openapi";
import { StreamReceipt } from "./StreamReceipt";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-test-001",
    recipient: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    rate: "12.5 XLM / hour",
    schedule: "Continuous (1s ticks)",
    status: "active",
    token: "XLM",
    createdAt: "2026-01-15T08:30:45.000Z",
    updatedAt: "2026-01-16T14:20:05.000Z",
    ...overrides,
  };
}

describe("StreamReceipt", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe("status badges", () => {
    it.each<[StreamStatus, string]>([
      ["draft", "Draft"],
      ["active", "Active"],
      ["paused", "Paused"],
      ["ended", "Ended"],
      ["withdrawn", "Withdrawn"],
      ["cancelled", "Cancelled"],
    ])(
      "renders human label and status class for %s",
      (status, expectedLabel) => {
        render(
          <StreamReceipt
            stream={makeStream({ status })}
            generatedAt="2026-01-17T00:00:00.000Z"
          />,
        );

        const badge = screen.getByText(expectedLabel);
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveClass(
          "receipt-status-badge",
          `receipt-status-badge--${status}`,
        );
      },
    );
  });

  describe("network badge", () => {
    it("defaults to Stellar Testnet", () => {
      render(
        <StreamReceipt
          stream={makeStream()}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      const badge = screen.getByText("Stellar Testnet");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute("data-network", "testnet");
    });

    it("renders Stellar Mainnet when network is mainnet", () => {
      render(
        <StreamReceipt
          stream={makeStream()}
          network="mainnet"
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      const badge = screen.getByText("Stellar Mainnet");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute("data-network", "mainnet");
    });
  });

  describe("payment details and UTC timestamp formatting", () => {
    it("renders rate, schedule, and UTC formatted timestamps", () => {
      render(
        <StreamReceipt
          stream={makeStream({
            rate: "42.0 XLM / day",
            schedule: "Monthly",
            createdAt: "2026-03-01T09:05:07.123Z",
            updatedAt: "2026-03-02T23:59:59.999Z",
          })}
          generatedAt="2026-03-03T12:00:00.000Z"
        />,
      );

      expect(screen.getByText("42.0 XLM / day")).toBeInTheDocument();
      expect(screen.getByText("Monthly")).toBeInTheDocument();
      expect(screen.getByText("2026-03-01 09:05:07 UTC")).toBeInTheDocument();
      expect(screen.getByText("2026-03-02 23:59:59 UTC")).toBeInTheDocument();
      expect(
        screen.getByText("Generated at: 2026-03-03 12:00:00 UTC"),
      ).toBeInTheDocument();
    });
  });

  describe("optional recipient fields", () => {
    it("hides label, email, and memo when absent", () => {
      render(
        <StreamReceipt
          stream={makeStream({
            label: undefined,
            email: undefined,
            memo: undefined,
          })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(screen.queryByText("Name / Label")).not.toBeInTheDocument();
      expect(screen.queryByText("Email")).not.toBeInTheDocument();
      expect(screen.queryByText("Memo")).not.toBeInTheDocument();
    });

    it("renders label, email, and memo when provided", () => {
      render(
        <StreamReceipt
          stream={makeStream({
            label: "Ada Creative Studio",
            email: "ada@example.com",
            memo: "Q1 retainer",
          })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(screen.getByText("Name / Label")).toBeInTheDocument();
      expect(screen.getByText("Ada Creative Studio")).toBeInTheDocument();
      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByText("ada@example.com")).toBeInTheDocument();
      expect(screen.getByText("Memo")).toBeInTheDocument();
      expect(screen.getByText("Q1 retainer")).toBeInTheDocument();
    });

    it("renders a very long memo without crashing", () => {
      const longMemo = "M".repeat(2000);
      render(
        <StreamReceipt
          stream={makeStream({ memo: longMemo })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(screen.getByText("Memo")).toBeInTheDocument();
      expect(screen.getByText(longMemo)).toBeInTheDocument();
    });
  });

  describe("optional settlement section", () => {
    it("hides the settlement section when neither settlementTxHash nor withdrawal is present", () => {
      render(
        <StreamReceipt
          stream={makeStream({
            settlementTxHash: undefined,
            withdrawal: undefined,
          })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(
        screen.queryByRole("heading", { name: /settlement & chain details/i }),
      ).not.toBeInTheDocument();
    });

    it("renders settlement section when settlementTxHash is provided", () => {
      const txHash =
        "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
      render(
        <StreamReceipt
          stream={makeStream({ settlementTxHash: txHash })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(
        screen.getByRole("heading", { name: /settlement & chain details/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Settlement TX")).toBeInTheDocument();
      expect(screen.queryByText("Withdrawal State")).not.toBeInTheDocument();
    });

    it("renders withdrawal details including confirmedTxHash and failureCode when provided", () => {
      const confirmedHash =
        "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
      render(
        <StreamReceipt
          stream={makeStream({
            status: "withdrawn",
            withdrawal: {
              state: "failed",
              requestedAt: "2026-02-10T11:22:33.000Z",
              lastCheckedAt: "2026-02-10T11:25:00.000Z",
              attempts: 3,
              confirmedTxHash: confirmedHash,
              failureCode: "TX_INSUFFICIENT_BALANCE",
            },
          })}
          generatedAt="2026-02-10T12:00:00.000Z"
        />,
      );

      expect(
        screen.getByRole("heading", { name: /settlement & chain details/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Withdrawal State")).toBeInTheDocument();
      expect(screen.getByText("failed")).toBeInTheDocument();
      expect(screen.getByText("Withdrawal Requested")).toBeInTheDocument();
      expect(screen.getByText("2026-02-10 11:22:33 UTC")).toBeInTheDocument();
      expect(screen.getByText("Confirmed TX")).toBeInTheDocument();
      expect(screen.getByText("Failure Code")).toBeInTheDocument();
      expect(screen.getByText("TX_INSUFFICIENT_BALANCE")).toBeInTheDocument();
    });
  });

  describe("optional partnerId and note", () => {
    it("renders partnerId and note only when provided", () => {
      const { rerender } = render(
        <StreamReceipt
          stream={makeStream({ partnerId: undefined })}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(screen.queryByText("Partner ID")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: /receipt note/i }),
      ).not.toBeInTheDocument();

      rerender(
        <StreamReceipt
          stream={makeStream({ partnerId: "partner-xyz" })}
          note="Paid in full for Q1"
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(screen.getByText("Partner ID")).toBeInTheDocument();
      expect(screen.getByText("partner-xyz")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /receipt note/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Paid in full for Q1")).toBeInTheDocument();
    });
  });

  describe("print toolbar", () => {
    it("renders the print button by default and calls window.print on click", () => {
      const printSpy = jest
        .spyOn(window, "print")
        .mockImplementation(() => undefined);

      render(
        <StreamReceipt
          stream={makeStream()}
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      const printButton = screen.getByRole("button", {
        name: /print \/ save as pdf/i,
      });
      expect(printButton).toBeInTheDocument();

      fireEvent.click(printButton);
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it("omits the print button when hideToolbar is true", () => {
      render(
        <StreamReceipt
          stream={makeStream()}
          hideToolbar
          generatedAt="2026-01-17T00:00:00.000Z"
        />,
      );

      expect(
        screen.queryByRole("button", { name: /print \/ save as pdf/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    it("throws RangeError when given an invalid ISO date string", () => {
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      expect(() =>
        render(
          <StreamReceipt
            stream={makeStream({ createdAt: "not-a-valid-iso-date" })}
            generatedAt="2026-01-17T00:00:00.000Z"
          />,
        ),
      ).toThrow(RangeError);

      errorSpy.mockRestore();
    });
  });
});
