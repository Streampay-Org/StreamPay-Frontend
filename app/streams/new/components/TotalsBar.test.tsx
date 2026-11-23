/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import TotalsBar, { TotalsBar as NamedTotalsBar } from "./TotalsBar";

describe("TotalsBar", () => {
  it("renders default values (0.00 USDC, 0 recipients) and caption", () => {
    render(<TotalsBar />);

    expect(screen.getByText("Total Stream Amount:")).toBeInTheDocument();
    expect(screen.getByText("0.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("Recipients:")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Running totals")).toBeInTheDocument();
  });

  it("exports the same component as named and default export", () => {
    expect(NamedTotalsBar).toBe(TotalsBar);
  });

  it("renders formatted multi-recipient values (1,250.50 XLM, 3)", () => {
    render(
      <TotalsBar totalAmount="1,250.50" tokenSymbol="XLM" recipientCount={3} />
    );

    expect(screen.getByText("Total Stream Amount:")).toBeInTheDocument();
    expect(screen.getByText("1,250.50 XLM")).toBeInTheDocument();
    expect(screen.getByText("Recipients:")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders very large amount strings verbatim without truncation or scientific notation", () => {
    const hugeAmount = "999,999,999,999,999,999,999,999.1234567";
    render(
      <TotalsBar
        totalAmount={hugeAmount}
        tokenSymbol="USDC"
        recipientCount={20}
      />
    );

    const renderedAmount = screen.getByText(`${hugeAmount} USDC`);
    expect(renderedAmount).toBeInTheDocument();
    expect(renderedAmount.textContent).toBe(`${hugeAmount} USDC`);
    expect(renderedAmount.textContent).not.toMatch(/e[+-]?\d+/i);
  });

  it("exposes label/value pairs in a readable order", () => {
    render(
      <TotalsBar totalAmount="1,250.50" tokenSymbol="XLM" recipientCount={3} />
    );

    const amountLabel = screen.getByText("Total Stream Amount:");
    const amountValue = screen.getByText("1,250.50 XLM");
    const recipientsLabel = screen.getByText("Recipients:");
    const recipientsValue = screen.getByText("3");
    const caption = screen.getByText("Running totals");

    expect(
      amountLabel.compareDocumentPosition(amountValue) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      amountValue.compareDocumentPosition(recipientsLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      recipientsLabel.compareDocumentPosition(recipientsValue) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      recipientsValue.compareDocumentPosition(caption) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders cleanly when totalAmount is an empty string", () => {
    render(
      <TotalsBar totalAmount="" tokenSymbol="USDC" recipientCount={2} />
    );

    const amountLabel = screen.getByText("Total Stream Amount:");
    const amountValue = amountLabel.nextElementSibling;
    expect(amountValue).not.toBeNull();
    expect(amountValue?.textContent?.trim()).toBe("USDC");
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders recipientCount 1 with the fixed 'Recipients:' label (no pluralisation logic)", () => {
    // Documented behaviour: TotalsBar always renders the plural label "Recipients:"
    // regardless of whether recipientCount is 1.
    render(
      <TotalsBar totalAmount="500.00" tokenSymbol="XLM" recipientCount={1} />
    );

    expect(screen.getByText("Recipients:")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
