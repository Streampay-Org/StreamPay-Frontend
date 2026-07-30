/**
 * @jest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import MobileLayout from "./layout";

// Mock next/navigation
const mockUsePathname = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

describe("MobileLayout Shell", () => {
  beforeEach(() => {
    mockUsePathname.mockReset();
  });

  it("renders layout brand header and status badge", () => {
    mockUsePathname.mockReturnValue("/streams");
    render(
      <MobileLayout>
        <div data-testid="child-content">Child View</div>
      </MobileLayout>
    );

    expect(screen.getByText("GrantFox")).toBeInTheDocument();
    expect(screen.getByLabelText(/network status: active/i)).toBeInTheDocument();
    expect(screen.getByText("Testnet")).toBeInTheDocument();
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("renders bottom navigation tabs with correct links", () => {
    mockUsePathname.mockReturnValue("/streams");
    render(<MobileLayout>Child</MobileLayout>);

    const nav = screen.getByRole("navigation", { name: /mobile navigation/i });
    expect(nav).toBeInTheDocument();

    const streamsLink = screen.getByRole("link", { name: /streams/i });
    const activityLink = screen.getByRole("link", { name: /activity/i });
    const contactsLink = screen.getByRole("link", { name: /contacts/i });
    const settingsLink = screen.getByRole("link", { name: /settings/i });

    expect(streamsLink).toHaveAttribute("href", "/streams");
    expect(activityLink).toHaveAttribute("href", "/activity");
    expect(contactsLink).toHaveAttribute("href", "/contacts");
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });

  it("highlights the active tab dynamically based on the current pathname", () => {
    mockUsePathname.mockReturnValue("/activity");
    render(<MobileLayout>Child</MobileLayout>);

    const activeLink = screen.getByRole("link", { name: /activity/i });
    expect(activeLink).toHaveAttribute("aria-current", "page");
    expect(activeLink.className).toContain("mobile-shell__nav-link--active");

    // Inactive link should not have active styling
    const inactiveLink = screen.getByRole("link", { name: /streams/i });
    expect(inactiveLink).not.toHaveAttribute("aria-current");
    expect(inactiveLink.className).not.toContain("mobile-shell__nav-link--active");
  });
});
