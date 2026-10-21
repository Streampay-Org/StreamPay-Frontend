/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import StreamDetailLoading from "./loading";

describe("StreamDetailLoading", () => {
  it("renders a role=status region announced to assistive tech", () => {
    render(<StreamDetailLoading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "Loading stream details");
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("includes a screen-reader-only loading message", () => {
    render(<StreamDetailLoading />);
    expect(screen.getByText(/loading stream details/i)).toHaveClass("sr-only");
  });

  it("keeps decorative skeletons hidden from the accessibility tree", () => {
    const { container } = render(<StreamDetailLoading />);
    const skeletons = container.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(8);
    skeletons.forEach((skeleton) => {
      expect(skeleton).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("mirrors the detail page structure with themed skeleton variants", () => {
    const { container } = render(<StreamDetailLoading />);
    expect(container.querySelector(".skeleton--title")).toBeInTheDocument();
    expect(container.querySelector(".skeleton--text")).toBeInTheDocument();
    expect(container.querySelector(".skeleton--badge")).toBeInTheDocument();
    expect(container.querySelector(".skeleton--value")).toBeInTheDocument();
    expect(container.querySelector(".skeleton--button")).toBeInTheDocument();
  });

  it("renders the payment timeline stage placeholders", () => {
    const { container } = render(<StreamDetailLoading />);
    const stages = container.querySelectorAll(".detail-loading__timeline-stage");
    expect(stages).toHaveLength(4);
  });
});
