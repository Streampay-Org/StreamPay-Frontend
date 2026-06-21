/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { PaymentTimeline } from "./PaymentTimeline";
import type { Stream } from "../types/openapi";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-1",
    recipient: "GDEST",
    rate: "100",
    schedule: "monthly",
    status: "active",
    token: "XLM",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("PaymentTimeline", () => {
  it("renders the section heading", () => {
    render(<PaymentTimeline stream={makeStream()} />);
    expect(screen.getByRole("heading", { name: /payment timeline/i })).toBeInTheDocument();
  });

  it("renders all four lifecycle steps", () => {
    render(<PaymentTimeline stream={makeStream()} />);
    expect(screen.getByText("Stream Created")).toBeInTheDocument();
    expect(screen.getByText("Stream Started")).toBeInTheDocument();
    expect(screen.getByText("Funds Settled")).toBeInTheDocument();
    expect(screen.getByText("Funds Withdrawn")).toBeInTheDocument();
  });

  it("marks the settled step as current for an active stream", () => {
    render(<PaymentTimeline stream={makeStream({ status: "active" })} />);
    const currentItem = document.querySelector('[aria-current="step"]');
    expect(currentItem).toBeInTheDocument();
    expect(currentItem).toHaveTextContent("Funds Settled");
  });

  it("marks the started step as current for a draft stream", () => {
    render(<PaymentTimeline stream={makeStream({ status: "draft" })} />);
    const currentItem = document.querySelector('[aria-current="step"]');
    expect(currentItem).toBeInTheDocument();
    expect(currentItem).toHaveTextContent("Stream Started");
  });

  it("marks the withdrawn step as current for an ended stream", () => {
    render(<PaymentTimeline stream={makeStream({ status: "ended" })} />);
    const currentItem = document.querySelector('[aria-current="step"]');
    expect(currentItem).toBeInTheDocument();
    expect(currentItem).toHaveTextContent("Funds Withdrawn");
  });

  it("shows no current step when stream is fully withdrawn", () => {
    render(
      <PaymentTimeline
        stream={makeStream({
          status: "withdrawn",
          withdrawal: {
            state: "succeeded",
            requestedAt: "2026-01-03T00:00:00.000Z",
            lastCheckedAt: "2026-01-03T00:00:00.000Z",
            attempts: 1,
          },
        })}
      />
    );
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });

  it("displays the settlement tx hash when present", () => {
    const txHash = "abcdef1234567890abcdef1234567890";
    render(<PaymentTimeline stream={makeStream({ settlementTxHash: txHash })} />);
    const hashEl = document.querySelector(".timeline-hash");
    expect(hashEl).toBeInTheDocument();
    expect(hashEl).toHaveAttribute("title", txHash);
  });

  it("renders the list with accessible label", () => {
    render(<PaymentTimeline stream={makeStream()} />);
    expect(
      screen.getByRole("list", { name: /payment lifecycle stages/i })
    ).toBeInTheDocument();
  });
});
