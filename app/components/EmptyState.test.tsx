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
    const heading = screen.getByRole("heading", { level: 2, name: DEFAULT_PROPS.title });
    const headingId = section.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(document.getElementById(headingId!)).toBe(heading);
  });

  it("uses unique semantic labels when multiple empty states render together", () => {
    render(
      <>
        <EmptyState {...DEFAULT_PROPS} title="First empty state" />
        <EmptyState {...DEFAULT_PROPS} title="Second empty state" />
      </>
    );

    const sections = screen.getAllByRole("region");
    expect(sections).toHaveLength(2);

    const labelledBy = sections.map((section) => section.getAttribute("aria-labelledby"));
    const describedBy = sections.map((section) => section.getAttribute("aria-describedby"));

    expect(new Set(labelledBy).size).toBe(2);
    expect(new Set(describedBy).size).toBe(2);
    sections.forEach((section) => {
      const titleId = section.getAttribute("aria-labelledby");
      const descriptionId = section.getAttribute("aria-describedby");
      expect(titleId).toBeTruthy();
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(titleId!)).not.toBeNull();
      expect(document.getElementById(descriptionId!)).not.toBeNull();
    });
  });

  it("keeps the CTA semantically tied to the empty-state explanation", () => {
    const steps = ["Pick a recipient", "Set a cadence"] as const;
    render(<EmptyState {...DEFAULT_PROPS} guidanceSteps={steps} onAction={jest.fn()} />);

    const button = screen.getByRole("button", { name: DEFAULT_PROPS.actionLabel });
    const describedBy = button.getAttribute("aria-describedby") ?? "";

    expect(describedBy.split(" ")).toHaveLength(2);
    describedBy.split(" ").forEach((id) => {
      expect(document.getElementById(id)).not.toBeNull();
    });
    expect(button).not.toBeDisabled();
  });

  it("renders a disabled CTA when no action handler is available", () => {
    render(<EmptyState {...DEFAULT_PROPS} />);

    expect(screen.getByRole("button", { name: DEFAULT_PROPS.actionLabel })).toBeDisabled();
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
