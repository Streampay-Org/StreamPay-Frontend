/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { SiteHeader } from "./SiteHeader";

jest.mock("next/navigation", () => ({
  usePathname: () => "/analytics",
}));

describe("SiteHeader analytics navigation", () => {
  it("links to Analytics and marks it active on /analytics", () => {
    render(<SiteHeader />);

    const analyticsLink = screen.getByRole("link", { name: "Analytics" });
    expect(analyticsLink).toHaveAttribute("href", "/analytics");
    expect(analyticsLink).toHaveAttribute("aria-current", "page");
  });
});
