/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { axe } from "jest-axe";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { STORAGE_KEYS } from "../lib/onboardingProgress";

describe("OnboardingChecklist", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("Scenario 1: Empty storage renders 0 of 4 done; all links are present", () => {
    render(<OnboardingChecklist />);

    expect(screen.getByRole("heading", { name: /get set up/i })).toBeInTheDocument();
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();

    const progressbar = screen.getByRole("progressbar", { name: /onboarding progress/i });
    expect(progressbar).toHaveAttribute("aria-valuenow", "0");
    expect(progressbar).toHaveAttribute("aria-valuetext", "0 of 4 done");

    // All links are present with appropriate text
    expect(screen.getByRole("link", { name: /connect wallet/i })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: /open contacts/i })).toHaveAttribute("href", "/contacts");
    expect(screen.getByRole("link", { name: /view templates/i })).toHaveAttribute("href", "/templates");
    expect(screen.getByRole("link", { name: /create stream/i })).toHaveAttribute("href", "/streams/new");

    // Statuses conveyed in text
    const todoBadges = screen.getAllByText("To do");
    expect(todoBadges).toHaveLength(4);

    // List is an <ol>
    const list = screen.getByRole("list");
    expect(list.tagName.toLowerCase()).toBe("ol");
  });

  it("Scenario 2: One contact saved marks the 'Save a contact' item as done", () => {
    localStorage.setItem(
      STORAGE_KEYS.CONTACTS,
      JSON.stringify([{ id: "contact-1", label: "Alice", address: "GXXX" }])
    );

    render(<OnboardingChecklist />);

    expect(screen.getByText("1 of 4 done")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();

    const contactItem = screen.getByTestId("checklist-item-save-contact");
    expect(contactItem).toHaveTextContent("Completed");
    expect(contactItem).toHaveTextContent("Save a contact");
  });

  it("Scenario 3: Wizard draft present marks the 'Create a stream' item as 'In progress'", () => {
    localStorage.setItem(
      STORAGE_KEYS.WIZARD_DRAFT,
      JSON.stringify({
        recipient: "GBVZZ...",
        amount: "50",
        token: "USDC",
        gasOnRecipient: true,
        savedAt: Date.now(),
      })
    );

    render(<OnboardingChecklist />);

    const streamItem = screen.getByTestId("checklist-item-create-stream");
    expect(streamItem).toHaveTextContent("In progress");
    expect(screen.getByRole("link", { name: /resume stream/i })).toHaveAttribute(
      "href",
      "/streams/new"
    );
  });

  it("Scenario 4: storage event from another tab updates progress and makes an announcement", () => {
    render(<OnboardingChecklist />);
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();

    // Trigger storage event simulating another tab saving a contact
    act(() => {
      localStorage.setItem(
        STORAGE_KEYS.CONTACTS,
        JSON.stringify([{ id: "contact-2", label: "Bob", address: "GBBB" }])
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEYS.CONTACTS,
          newValue: JSON.stringify([{ id: "contact-2" }]),
        })
      );
    });

    expect(screen.getByText("1 of 4 done")).toBeInTheDocument();
    const liveRegion = screen.getByTestId("onboarding-checklist-live");
    expect(liveRegion).toHaveTextContent("Checklist updated: 1 of 4 tasks completed.");
  });

  it("Scenario 5: Hide checklist persists and is not rendered after a reload", () => {
    const { unmount } = render(<OnboardingChecklist />);

    const hideButton = screen.getByRole("button", { name: /hide checklist/i });
    fireEvent.click(hideButton);

    expect(localStorage.getItem(STORAGE_KEYS.HIDE_CHECKLIST)).toBe("true");
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();

    unmount();

    // Reload test: re-render with storage having hide flag
    render(<OnboardingChecklist />);
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
  });

  it("Scenario 6: All done shows the completion state", () => {
    localStorage.setItem(STORAGE_KEYS.WALLET_MRU, "freighter");
    localStorage.setItem(
      STORAGE_KEYS.CONTACTS,
      JSON.stringify([{ id: "contact-1", label: "Alice", address: "GXXX" }])
    );
    localStorage.setItem(STORAGE_KEYS.TEMPLATES_VISITED, "true");
    localStorage.setItem(STORAGE_KEYS.STREAM_CREATED, "true");

    render(<OnboardingChecklist />);

    expect(screen.getByText("4 of 4 done")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-completion")).toBeInTheDocument();
    expect(screen.getByText(/you're all set!/i)).toBeInTheDocument();
  });

  it("Scenario 7: Storage throws - renders 0 of 4 with no crash", () => {
    const getItemSpy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("QuotaExceededError or SecurityError in private mode");
    });

    render(<OnboardingChecklist />);

    expect(screen.getByRole("heading", { name: /get set up/i })).toBeInTheDocument();
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();

    getItemSpy.mockRestore();
  });

  it("Scenario 8: axe accessibility check has no serious or critical violations", async () => {
    const { container } = render(<OnboardingChecklist />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
