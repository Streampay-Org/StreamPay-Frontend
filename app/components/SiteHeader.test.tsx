/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { SiteHeader } from "./SiteHeader";

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
}));

const mockedUsePathname = usePathname as jest.MockedFunction<
  typeof usePathname
>;

describe("SiteHeader", () => {
  beforeEach(() => {
    mockedUsePathname.mockReset();
  });

  it("renders the primary navigation landmark, brand link, and New stream CTA", () => {
    mockedUsePathname.mockReturnValue("/");
    render(<SiteHeader />);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();

    const brandLink = screen.getByRole("link", { name: "StreamPay home" });
    expect(brandLink).toHaveAttribute("href", "/");

    const ctaLink = screen.getByRole("link", { name: "New stream" });
    expect(ctaLink).toHaveAttribute("href", "/streams/new");
  });

  it.each<{
    pathname: string | null;
    expectedActiveLabel: string | null;
  }>([
    { pathname: "/streams", expectedActiveLabel: "Streams" },
    { pathname: "/streams/abc/events", expectedActiveLabel: "Streams" },
    { pathname: "/activity", expectedActiveLabel: "Activity" },
    { pathname: "/streams-archive", expectedActiveLabel: null },
    { pathname: "/", expectedActiveLabel: null },
    { pathname: null, expectedActiveLabel: null },
  ])(
    "highlights $expectedActiveLabel for pathname $pathname",
    ({ pathname, expectedActiveLabel }) => {
      mockedUsePathname.mockReturnValue(pathname as string);
      render(<SiteHeader />);

      const nav = screen.getByRole("navigation", { name: "Primary" });
      const navLinks = within(nav).getAllByRole("link");
      const currentLinks = navLinks.filter(
        (link) => link.getAttribute("aria-current") === "page"
      );

      if (expectedActiveLabel) {
        expect(currentLinks).toHaveLength(1);
        expect(currentLinks[0]).toHaveTextContent(expectedActiveLabel);
        expect(currentLinks[0]).toHaveClass("is-active");
        expect(currentLinks[0]).toHaveAttribute("aria-current", "page");

        for (const link of navLinks) {
          if (link !== currentLinks[0]) {
            expect(link).not.toHaveAttribute("aria-current");
            expect(link).not.toHaveClass("is-active");
          }
        }
      } else {
        expect(currentLinks).toHaveLength(0);
        for (const link of navLinks) {
          expect(link).not.toHaveAttribute("aria-current");
          expect(link).not.toHaveClass("is-active");
        }
      }
    }
  );
});
