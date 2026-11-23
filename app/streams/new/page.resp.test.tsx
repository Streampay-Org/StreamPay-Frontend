/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import NewStreamPage from "./page";

jest.mock("../../state/recentRecipients", () => ({
  addRecentRecipient: jest.fn(),
  getRecentRecipients: jest.fn(() => []),
}));

const createMockMedia = (matches: boolean) => {
  return () => ({
    matches,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
};

describe("CreateStreamForm responsive (#1042 v7)", () => {
  beforeAll(() => {
    window.matchMedia = createMockMedia(false) as any;
  });

  it("renders CTA banner with csf-cta-banner class", () => {
    render(<NewStreamPage />);
    const banner = screen.getByTestId("csf-cta-banner");
    expect(banner).toHaveClass("csf-cta-banner");
  });

  it("renders form section with csf-section class", () => {
    render(<NewStreamPage />);
    const ctaSection = screen.getByTestId("csf-cta-section");
    const formSection = screen.getByTestId("csf-form-section");
    expect(ctaSection).toHaveClass("csf-section");
    expect(formSection).toHaveClass("csf-section");
  });

  it("renders Amount+Token grid with csf-field-row class", () => {
    render(<NewStreamPage />);
    const fieldRow = screen.getByTestId("csf-field-row");
    expect(fieldRow).toHaveClass("csf-field-row");
    expect(fieldRow.querySelector("#amount")).toBeInTheDocument();
    expect(fieldRow.querySelector("#token")).toBeInTheDocument();
  });

  it("renders action buttons container with csf-actions class", () => {
    render(<NewStreamPage />);
    const actions = screen.getByTestId("csf-actions");
    expect(actions).toHaveClass("csf-actions");
    expect(actions.querySelector('button[type="submit"]')).toBeInTheDocument();
    expect(actions.querySelector('button[type="button"]')).toBeInTheDocument();
  });

  it("all key responsive containers are present", () => {
    render(<NewStreamPage />);
    expect(screen.getByTestId("csf-cta-section")).toBeInTheDocument();
    expect(screen.getByTestId("csf-cta-banner")).toBeInTheDocument();
    expect(screen.getByTestId("csf-form-section")).toBeInTheDocument();
    expect(screen.getByTestId("csf-field-row")).toBeInTheDocument();
    expect(screen.getByTestId("csf-actions")).toBeInTheDocument();
    expect(screen.getByTestId("create-stream-form")).toBeInTheDocument();
  });

  it("CSA form fields remain functional across viewport sizes", () => {
    render(<NewStreamPage />);
    const recipient = screen.getByLabelText(/recipient address/i);
    const amount = screen.getByLabelText(/amount/i);
    const token = screen.getByLabelText(/token/i);

    expect(recipient).toBeEnabled();
    expect(amount).toBeEnabled();
    expect(token).toBeEnabled();
  });

  it("mobile bottom sheet still triggers at narrow viewport", async () => {
    window.matchMedia = createMockMedia(true) as any;
    const { fireEvent } = require("@testing-library/react");
    render(<NewStreamPage />);

    const recipientInput = screen.getByLabelText(/recipient address/i);
    const amountInput = screen.getByLabelText(/amount/i);
    const submitButton = screen.getByRole("button", { name: /create stream/i });

    fireEvent.change(recipientInput, {
      target: { value: "GD72X2Y3B6V7XW5P4D8Q2Z9K0F1E3R5T7Y9U0I2O4P6A8S0D2F4G6H8J" },
    });
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(submitButton);

    const { waitFor } = require("@testing-library/react");
    await waitFor(() => {
      expect(screen.getByTestId("bottom-sheet-overlay")).toBeInTheDocument();
    });
  });
});
