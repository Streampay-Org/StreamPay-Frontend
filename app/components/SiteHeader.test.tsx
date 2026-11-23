import React from "react";
import { render, screen } from "@testing-library/react";
import { SiteHeader } from "./SiteHeader";

let mockPathname = "/";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

describe("SiteHeader", () => {
  it("renders the Orgs link in primary navigation", () => {
    mockPathname = "/streams";
    render(<SiteHeader />);

    const orgsLink = screen.getByRole("link", { name: "Orgs" });
    expect(orgsLink).toHaveAttribute("href", "/orgs");
    expect(orgsLink).not.toHaveAttribute("aria-current");
  });

  it("marks Orgs as active on /orgs", () => {
    mockPathname = "/orgs";
    render(<SiteHeader />);

    const orgsLink = screen.getByRole("link", { name: "Orgs" });
    expect(orgsLink).toHaveAttribute("aria-current", "page");
    expect(orgsLink).toHaveClass("is-active");
  });

  it("marks Orgs as active on nested /orgs/[orgId] routes", () => {
    mockPathname = "/orgs/org-acme";
    render(<SiteHeader />);

    const orgsLink = screen.getByRole("link", { name: "Orgs" });
    expect(orgsLink).toHaveAttribute("aria-current", "page");
    expect(orgsLink).toHaveClass("is-active");
  });
});
