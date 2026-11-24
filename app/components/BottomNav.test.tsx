/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { BottomNav } from "./BottomNav";
import type { BottomNavItem } from "./BottomNav";

const withIcon: BottomNavItem[] = [
  { href: "/streams", label: "Streams", badgeCount: 3, icon: <svg data-testid="icon-streams" /> },
  { href: "/activity", label: "Activity", icon: <svg data-testid="icon-activity" /> },
  { href: "/settings", label: "Settings", badgeCount: 12, icon: <svg data-testid="icon-settings" /> },
];

describe("BottomNav", () => {
  beforeEach(() => {
    (usePathname as jest.Mock).mockReturnValue("/streams");
  });

  it("renders an accessible primary navigation with every item", () => {
    render(<BottomNav items={withIcon} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText("Streams")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("marks the active route with aria-current", () => {
    render(<BottomNav items={withIcon} />);
    const active = screen.getByText("Streams").closest("a");
    expect(active).toHaveAttribute("aria-current", "page");
    const inactive = screen.getByText("Activity").closest("a");
    expect(inactive).not.toHaveAttribute("aria-current");
  });

  it("shows a badge with screen-reader text for pending actions", () => {
    render(<BottomNav items={withIcon} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("3 pending")).toBeInTheDocument();
  });

  it("caps large badge counts but announces the exact number", () => {
    render(<BottomNav items={withIcon} maxBadgeCount={9} />);
    expect(screen.getByText("9+")).toBeInTheDocument();
    expect(screen.getByText("12 pending")).toBeInTheDocument();
  });

  it("omits the badge when there are no pending actions", () => {
    render(<BottomNav items={withIcon} />);
    const activity = screen.getByText("Activity").closest("a");
    expect(activity?.querySelector(".bottom-nav__badge")).toBeNull();
  });

  it("renders icons when provided", () => {
    render(<BottomNav items={withIcon} />);
    expect(screen.getByTestId("icon-streams")).toBeInTheDocument();
    expect(screen.getByTestId("icon-activity")).toBeInTheDocument();
    expect(screen.getByTestId("icon-settings")).toBeInTheDocument();
  });
});
