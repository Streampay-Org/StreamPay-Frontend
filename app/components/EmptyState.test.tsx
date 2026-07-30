/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

const DEFAULT_PROPS = {
  actionLabel: "Create your first stream",
  eyebrow: "First-time setup",
  title: "Start your first stream",
  description:
    "Get started with a single payout flow. Define a recipient, cadence, and amount in minutes.",
} as const;

describe("EmptyState", () => {
  it("renders eyebrow, title, description, and action label", () => {
    render(<EmptyState {...DEFAULT_PROPS} />);

    expect(screen.getByText(DEFAULT_PROPS.eyebrow)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: DEFAULT_PROPS.title })
    ).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_PROPS.description)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: DEFAULT_PROPS.actionLabel })
    ).toBeInTheDocument();
  });

  it("wires the onAction prop to the primary CTA button", () => {
    const onAction = jest.fn();
    render(<EmptyState {...DEFAULT_PROPS} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: DEFAULT_PROPS.actionLabel }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("forwards an additional className onto the root <section>", () => {
    const { container } = render(<EmptyState {...DEFAULT_PROPS} className="hero-empty" />);
    expect(container.querySelector("section.empty-state")).toHaveClass("hero-empty");
  });

  it("keeps aria-labelledby pointing at the h2 (screen-reader accessible)", () => {
    const { container } = render(<EmptyState {...DEFAULT_PROPS} />);
    const section = container.querySelector("section.empty-state")!;
    const headingId = section.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    const h2 = section.querySelector("h2#" + headingId);
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe(DEFAULT_PROPS.title);
  });

  it("renders supporting children when provided", () => {
    render(
      <EmptyState {...DEFAULT_PROPS}>
        <div data-testid="supporting">Helpful next steps</div>
      </EmptyState>
    );

    expect(screen.getByTestId("supporting")).toBeInTheDocument();
  });

  it("renders guidanceSteps as a structured <ul> when provided", () => {
    const steps = ["Pick a recipient", "Set a cadence", "Launch it"] as const;
    const { container } = render(<EmptyState {...DEFAULT_PROPS} guidanceSteps={steps} />);
    const list = container.querySelector("ul.empty-state__supporting-list");
    expect(list).not.toBeNull();
    const items = list!.querySelectorAll("li");
    expect(items.length).toBe(steps.length);
    steps.forEach((step, i) => expect(items[i]?.textContent).toBe(step));
  });

  it("renders the supporting-title prefix when guidanceSteps are the only supporting content", () => {
    const steps = ["Pick a recipient"] as const;
    render(<EmptyState {...DEFAULT_PROPS} guidanceSteps={steps} />);
    expect(screen.getByText(/What you'll set up/i)).toBeInTheDocument();
  });

  it("omits the supporting-title prefix when explicit children are already provided", () => {
    const steps = ["Pick a recipient"] as const;
    render(
      <EmptyState {...DEFAULT_PROPS} guidanceSteps={steps}>
        <p>My custom heading</p>
      </EmptyState>
    );
    expect(screen.queryByText(/What you'll set up/i)).not.toBeInTheDocument();
    expect(screen.getByText(/My custom heading/i)).toBeInTheDocument();
  });

  describe("variant prop (illustration control)", () => {
    it("streams variant (default) renders the v7 EmptyIllustration inside .empty-state__illustration", () => {
      const { container } = render(<EmptyState {...DEFAULT_PROPS} />);
      const wrap = container.querySelector(".empty-state__illustration");
      expect(wrap).not.toBeNull();
      expect(wrap).toHaveAttribute("aria-hidden", "true");
      expect(wrap!.querySelector("svg")).not.toBeNull();
      expect(container.querySelector("section.empty-state")).toHaveClass("empty-state--streams");
    });

    it("stream-progress variant renders the StreamProgressEmptyIllustration inside .empty-state__illustration", () => {
      const { container } = render(<EmptyState {...DEFAULT_PROPS} variant="stream-progress" />);
      const wrap = container.querySelector(".empty-state__illustration");
      expect(wrap).not.toBeNull();
      expect(wrap).toHaveAttribute("aria-hidden", "true");
      const svg = wrap!.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.innerHTML).toContain("var(--accent)");
      expect(container.querySelector("section.empty-state")).toHaveClass("empty-state--stream-progress");
    });

    it("generic variant omits the illustration entirely", () => {
      const { container } = render(<EmptyState {...DEFAULT_PROPS} variant="generic" />);
      expect(container.querySelector(".empty-state__illustration")).toBeNull();
      expect(container.querySelector("svg")).toBeNull();
      expect(container.querySelector("section.empty-state")).not.toHaveClass(
        "empty-state--streams"
      );
    });
  });
});
