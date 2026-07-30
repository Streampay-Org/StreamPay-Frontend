/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import NewStreamPage from "./page";

// Mock recentRecipients module
jest.mock("../../state/recentRecipients", () => ({
  addRecentRecipient: jest.fn(),
  getRecentRecipients: jest.fn(() => []),
}));

// Mock window.matchMedia
const createMockMedia = (matches: boolean) => {
  return () => ({
    matches,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
};

describe("CreateStreamForm focus-visible (#1046)", () => {
  beforeAll(() => {
    window.matchMedia = createMockMedia(false) as any;
  });

  it("renders the form with data-testid and className", () => {
    render(<NewStreamPage />);

    const form = screen.getByTestId("create-stream-form");
    expect(form).toBeInTheDocument();
    expect(form).toHaveClass("create-stream-form");
    expect(form.tagName.toLowerCase()).toBe("form");
  });

  it("recipient input has csf-field class for focus-visible styling", () => {
    render(<NewStreamPage />);

    const recipientInput = screen.getByLabelText(/recipient address/i);
    expect(recipientInput).toHaveClass("csf-field");
  });

  it("amount input has csf-field class for focus-visible styling", () => {
    render(<NewStreamPage />);

    const amountInput = screen.getByLabelText(/amount/i);
    expect(amountInput).toHaveClass("csf-field");
  });

  it("token select has csf-field class for focus-visible styling", () => {
    render(<NewStreamPage />);

    const tokenSelect = screen.getByLabelText(/token/i);
    expect(tokenSelect).toHaveClass("csf-field");
  });

  it("Cancel button has csf-field class for focus-visible styling", () => {
    render(<NewStreamPage />);

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    expect(cancelButton).toHaveClass("csf-field");
    expect(cancelButton).toHaveClass("button--secondary");
  });

  it("Create Stream button has csf-field class for focus-visible styling", () => {
    render(<NewStreamPage />);

    const submitButton = screen.getByRole("button", { name: /create stream/i });
    expect(submitButton).toHaveClass("csf-field");
    expect(submitButton).toHaveClass("button--primary");
  });

  it("all interactive form elements have csf-field class", () => {
    const { container } = render(<NewStreamPage />);

    const form = screen.getByTestId("create-stream-form");
    const csfFields = form.querySelectorAll(".csf-field");

    // recipient input, amount input, token select, cancel button, create button = 5
    expect(csfFields.length).toBeGreaterThanOrEqual(5);
  });
});
