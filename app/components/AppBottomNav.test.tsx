/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { usePathname } from "next/navigation";
import { AppBottomNav } from "./AppBottomNav";

describe("AppBottomNav", () => {
  beforeEach(() => {
    (usePathname as jest.Mock).mockReturnValue("/streams");
  });

  it("hides the bottom nav on the home page", () => {
    (usePathname as jest.Mock).mockReturnValue("/");
    render(<AppBottomNav />);
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("shows the bottom nav on app pages", () => {
    render(<AppBottomNav />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Streams")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
