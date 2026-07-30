/**
 * @jest-environment jsdom
 *
 * Focused tests for the wizard state persistence / "Save draft" feature (#863).
 *
 * Scope:
 *  - Save wizard draft state to localStorage on input changes.
 *  - Restore state from localStorage on mount and populate input fields.
 *  - Show draft restored banner with discard option.
 *  - Discarding clear the draft and fields.
 *  - Successful stream submission clears the draft.
 */

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import NewStreamPage from "./page";
import { WIZARD_DRAFT_KEY } from "../../state/wizardDraft";

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

describe("NewStreamPage - Save Draft State (#863)", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeAll(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterAll(() => {
    window.matchMedia = originalMatchMedia;
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.matchMedia = createMockMedia(false) as any;
  });

  it("saves draft to localStorage as user types", () => {
    render(<NewStreamPage />);

    const recipientInput = screen.getByLabelText(/recipient address/i);
    const amountInput = screen.getByLabelText(/amount/i);
    const tokenSelect = screen.getByLabelText(/token/i);

    fireEvent.change(recipientInput, { target: { value: "GD72X2Y3B6V7XW5P" } });
    fireEvent.change(amountInput, { target: { value: "250" } });
    fireEvent.change(tokenSelect, { target: { value: "USDC" } });

    const raw = window.localStorage.getItem(WIZARD_DRAFT_KEY);
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!);
    expect(parsed.recipient).toBe("GD72X2Y3B6V7XW5P");
    expect(parsed.amount).toBe("250");
    expect(parsed.token).toBe("USDC");
    expect(parsed.gasOnRecipient).toBe(false);
    expect(parsed.savedAt).toBeGreaterThan(0);
  });

  it("restores draft from localStorage on mount and displays restored banner", () => {
    const savedDraft = {
      recipient: "GD72X2Y3B6V7XW5P",
      amount: "450",
      token: "USDC" as const,
      gasOnRecipient: true,
      savedAt: Date.now() - 5000,
    };
    window.localStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify(savedDraft));

    render(<NewStreamPage />);

    expect(screen.getByTestId("draft-restored-banner")).toBeInTheDocument();
    expect(screen.getByLabelText(/recipient address/i)).toHaveValue("GD72X2Y3B6V7XW5P");
    expect(screen.getByLabelText(/amount/i)).toHaveValue(450);
    expect(screen.getByLabelText(/token/i)).toHaveValue("USDC");
  });

  it("clears state and fields when discard draft is clicked", () => {
    const savedDraft = {
      recipient: "GD72X2Y3B6V7XW5P",
      amount: "450",
      token: "USDC" as const,
      gasOnRecipient: true,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify(savedDraft));

    render(<NewStreamPage />);

    expect(screen.getByTestId("draft-restored-banner")).toBeInTheDocument();

    const discardBtn = screen.getByTestId("discard-draft-btn");
    fireEvent.click(discardBtn);

    expect(screen.queryByTestId("draft-restored-banner")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/recipient address/i)).toHaveValue("");
    expect(screen.getByLabelText(/amount/i)).toHaveValue(null);
    expect(screen.getByLabelText(/token/i)).toHaveValue("XLM");

    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).toBeNull();
  });

  it("clears localStorage draft on successful stream creation", async () => {
    render(<NewStreamPage />);

    const recipientInput = screen.getByLabelText(/recipient address/i);
    const amountInput = screen.getByLabelText(/amount/i);
    const submitButton = screen.getByRole("button", { name: /create stream/i });

    fireEvent.change(recipientInput, { target: { value: "GD72X2Y3B6V7XW5P4D8Q2Z9K0F1E3R5T7Y9U0I2O4P6A8S0D2F4G6H8J" } });
    fireEvent.change(amountInput, { target: { value: "150" } });

    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).not.toBeNull();

    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /stream created/i })).toBeInTheDocument();
    });

    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).toBeNull();
  });
});

// Helper for screen
const screen = {
  getByLabelText: (matcher: any) => {
    const labels = document.querySelectorAll("label");
    for (const label of Array.from(labels)) {
      if (label.textContent && matcher.test(label.textContent)) {
        const htmlFor = label.getAttribute("for");
        if (htmlFor) {
          const el = document.getElementById(htmlFor);
          if (el) return el;
        }
      }
    }
    throw new Error(`Label not found: ${matcher}`);
  },
  getByRole: (role: string, options?: { name?: any }) => {
    if (role === "heading") {
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const h of Array.from(headings)) {
        if (options?.name && options.name.test(h.textContent)) {
          return h;
        }
      }
    }
    if (role === "button") {
      const buttons = document.querySelectorAll("button");
      for (const b of Array.from(buttons)) {
        if (options?.name && options.name.test(b.textContent)) {
          return b;
        }
      }
    }
    throw new Error(`Role not found: ${role} ${JSON.stringify(options)}`);
  },
  getByTestId: (id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el) return el;
    throw new Error(`Test ID not found: ${id}`);
  },
  queryByTestId: (id: string) => {
    return document.querySelector(`[data-testid="${id}"]`);
  },
  queryByText: (text: string) => {
    const nodes = document.querySelectorAll("*");
    for (const n of Array.from(nodes)) {
      if (n.textContent === text) return n;
    }
    return null;
  },
};
