/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import SettingsLoading from "./loading";

describe("SettingsLoading", () => {
  it("renders a role=status region with aria-busy and route-specific label", () => {
    render(<SettingsLoading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-label", "Loading settings");
  });

  it("includes a screen-reader-only loading message", () => {
    render(<SettingsLoading />);
    expect(screen.getByText(/loading settings/i)).toHaveClass("sr-only");
  });

  it("renders no interactive elements and hides decorative skeletons", () => {
    const { container } = render(<SettingsLoading />);
    expect(container.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    const skeletons = container.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
    skeletons.forEach((skeleton) => {
      expect(skeleton).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = render(<SettingsLoading />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
