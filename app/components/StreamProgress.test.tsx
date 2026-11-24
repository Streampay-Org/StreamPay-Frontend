/** @jest-environment jsdom */
import fs from "fs";
import path from "path";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StreamProgress } from "./StreamProgress";

// ── matchMedia mock ─────────────────────────────────────────────────────────

/** Installs a matchMedia mock that reports the given reduced-motion preference. */
function mockMatchMedia(prefersReduced: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? prefersReduced : false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
}

// ── Existing: reduced-motion tests ──────────────────────────────────────────

describe("StreamProgress reduced-motion fallback", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("animates the fill when reduced motion is not requested", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.parentElement).toHaveClass("stream-progress--animated");
    expect(bar.parentElement).toHaveAttribute("data-reduced-motion", "false");

    const fill = bar.querySelector(".stream-progress__fill") as HTMLElement;
    expect(fill.style.transition).toBe("width 400ms ease");
  });

  it("renders a static fill when reduced motion is requested", () => {
    mockMatchMedia(true);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.parentElement).toHaveClass("stream-progress--static");
    expect(bar.parentElement).toHaveAttribute("data-reduced-motion", "true");

    const fill = bar.querySelector(".stream-progress__fill") as HTMLElement;
    expect(fill.style.transition).toBe("none");
    // The fill is still positioned to reflect progress — only the motion is removed.
    expect(fill.style.width).toBe("50%");
  });

  it("applies static class on first render, not after an effect (no flash)", () => {
    // The hook reads matchMedia synchronously in useState so the correct modifier
    // is present from the very first render — there's no frame where the animated
    // class appears before being swapped out.
    mockMatchMedia(true);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    // If state were initialised to false and corrected in useEffect, the first
    // render would produce --animated; lazy initialisation means it's --static.
    expect(screen.getByRole("progressbar").parentElement).toHaveClass("stream-progress--static");
  });

  it("preserves the accessible progress value regardless of motion preference", () => {
    mockMatchMedia(true);
    render(<StreamProgress status="active" accruedAmount={25} totalAmount={100} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });
});

// ── Color-blind safe patterns ───────────────────────────────────────────────

describe("StreamProgress color-blind safe patterns", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it.each([
    ["active", "cb-pattern--active"],
    ["paused", "cb-pattern--paused"],
    ["draft", "cb-pattern--draft"],
    ["ended", "cb-pattern--ended"],
    ["withdrawn", "cb-pattern--ended"],
    ["cancelled", "cb-pattern--cancelled"],
  ] as const)("applies the %s fill texture class", (status, patternClass) => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress status={status} accruedAmount={50} totalAmount={100} />
    );

    const fill = container.querySelector(".stream-progress__fill");
    expect(fill).toHaveClass("cb-pattern");
    expect(fill).toHaveClass(patternClass);
  });
});

// ── Keyboard focus ──────────────────────────────────────────────────────────

describe("StreamProgress keyboard focus", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("is reachable via keyboard tab order", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("tabIndex", "0");
  });

  it("receives real DOM focus and carries the shared focus-visible class hook", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);

    const bar = screen.getByRole("progressbar");
    bar.focus();

    expect(bar).toHaveFocus();
    expect(bar).toHaveClass("stream-progress__track");
  });
});

// ── Progressbar role tests ──────────────────────────────────────────────────

describe("StreamProgress progressbar semantics", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("has correct aria attributes for active stream", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={25} totalAmount={100} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "25% accrued");
  });

  it("shows 'Not started' for draft status", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="draft" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "Not started");
  });

  it("shows 'Completed' for ended status", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="ended" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "Completed");
  });
});

// ── Spacing/typography design tokens (FWC26 Stellar Wave) ───────────────────

describe("StreamProgress spacing/typography design tokens", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "globals.css"), "utf8");

  /** Returns the declaration block body for a top-level CSS selector. */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  }

  it("defines the spacing scale tokens referenced across the app", () => {
    for (const token of ["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-8"]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("defines the typography scale tokens referenced across the app", () => {
    for (const token of ["--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl", "--text-4xl"]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("defines the font-weight tokens referenced across the app", () => {
    for (const token of ["--font-medium", "--font-semibold", "--font-bold"]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("pins the track/label gap to a spacing token instead of a hardcoded rem value", () => {
    const rule = ruleBody(".stream-progress");
    expect(rule).toContain("gap: var(--space-2)");
  });

  it("pins the meta row gap to a spacing token", () => {
    const rule = ruleBody(".stream-progress__meta");
    expect(rule).toContain("gap: var(--space-4)");
  });

  it("pins the percentage label's typography to design tokens", () => {
    const rule = ruleBody(".stream-progress__label");
    expect(rule).toContain("font-size: var(--text-sm)");
    expect(rule).toContain("font-weight: var(--font-semibold)");
  });

  it("pins the remaining-balance font-size to a typography token", () => {
    const rule = ruleBody(".stream-progress__remaining");
    expect(rule).toContain("font-size: var(--text-xs)");
  });

  it("defines skeleton pointer-events and user-select disable rules", () => {
    const rule = ruleBody(".stream-progress--skeleton");
    expect(rule).toContain("pointer-events: none");
    expect(rule).toContain("user-select: none");
  });

  it("skeleton-track uses pill border-radius", () => {
    const rule = ruleBody(".stream-progress__skeleton-track");
    expect(rule).toContain("border-radius: 999px");
  });

  it("skeleton-meta mirrors the .stream-progress__meta layout tokens", () => {
    const rule = ruleBody(".stream-progress__skeleton-meta");
    expect(rule).toContain("display: flex");
    expect(rule).toContain("gap: var(--space-4)");
    expect(rule).toContain("justify-content: space-between");
    expect(rule).toContain("align-items: baseline");
  });
});

// ── Aria-live announcements ─────────────────────────────────────────────────

describe("StreamProgress aria-live announcements", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("renders a LiveRegion with data-testid stream-progress-live", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    expect(screen.getByTestId("stream-progress-live")).toBeInTheDocument();
  });

  it("has empty announcement on initial render (no false positive)", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const region = screen.getByTestId("stream-progress-live");
    expect(region).toHaveTextContent("");
  });

  it("announces 'Stream paused' when status changes to paused", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="paused" accruedAmount={50} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream paused");
  });

  it("announces 'Stream completed' when status changes to ended", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="ended" accruedAmount={100} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream completed");
  });

  it("announces 'Stream withdrawn' when status changes to withdrawn", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="withdrawn" accruedAmount={50} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream withdrawn");
  });

  it("announces 'Stream cancelled' when status changes to cancelled", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="cancelled" accruedAmount={50} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream cancelled");
  });

  it("announces 'Stream resumed' when status changes from paused to active", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="paused" accruedAmount={50} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream resumed");
  });

  it("announces progress milestone when percent changes by >= 10", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={20} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("Stream progress: 50% accrued");
  });

  it("does not announce for small percent changes (< 10%)", () => {
    mockMatchMedia(false);
    const { rerender } = render(
      <StreamProgress status="active" accruedAmount={20} totalAmount={100} />,
    );
    rerender(
      <StreamProgress status="active" accruedAmount={25} totalAmount={100} />,
    );
    expect(screen.getByTestId("stream-progress-live")).toHaveTextContent("");
  });

  it("live region uses polite politeness by default", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const region = screen.getByTestId("stream-progress-live");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("role", "status");
  });
});

// ── Responsive layout tests ─────────────────────────────────────────────────

describe("StreamProgress responsive layout", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("renders the correct BEM structure for CSS responsive hooks", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );

    expect(container.querySelector(".stream-progress")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__track")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__fill")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__meta")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__label")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__remaining")).toBeInTheDocument();
  });

  it("renders label and remaining amount within meta for responsive stacking", () => {
    mockMatchMedia(false);
    render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );

    const meta = screen.getByText("50% accrued").closest(".stream-progress__meta");
    expect(meta).toBeInTheDocument();
    expect(meta).toContainElement(screen.getByText("50% accrued"));
    expect(meta).toContainElement(screen.getByText("50 remaining"));
  });

  it("suppresses remaining when totalAmount is zero", () => {
    mockMatchMedia(false);
    render(
      <StreamProgress status="active" accruedAmount={0} totalAmount={0} />,
    );

    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("shows zero remaining when fully accrued", () => {
    mockMatchMedia(false);
    render(
      <StreamProgress status="active" accruedAmount={100} totalAmount={100} />,
    );

    expect(screen.getByText("0 remaining")).toBeInTheDocument();
  });

  it("applies tabular-nums to remaining for stable digit widths", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />,
    );

    const remaining = container.querySelector(".stream-progress__remaining");
    expect(remaining).toHaveClass("tabular-nums");
  });

  it("renders without remaining when totalAmount is omitted", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} />);

    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("renders without remaining when accruedAmount is omitted", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" totalAmount={100} />);

    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("applies className prop to the root element for contextual overrides", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        accruedAmount={50}
        totalAmount={100}
        className="stream-row__progress"
      />,
    );

    const root = container.querySelector(".stream-progress");
    expect(root).toHaveClass("stream-row__progress");
  });

  it("renders ended status without remaining amount calculation", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="ended" />);

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("renders draft status without remaining amount", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="draft" />);

    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("renders cancelled status without remaining amount", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="cancelled" />);

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("renders withdrawn status without remaining amount", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="withdrawn" />);

    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
  });

  it("empty state passes className through", () => {
    mockMatchMedia(false);
    render(
      <StreamProgress
        status="empty"
        className="custom-empty-class"
      />,
    );

    const section = screen.getByRole("heading", { name: "No active stream found" })
      .closest("section")!;
    expect(section).toHaveClass("custom-empty-class");
  });
});

// ── Loading skeleton tests ────────────────────────────────────────────────

describe("StreamProgress loading skeleton", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("renders skeleton when loading is true", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    const root = container.querySelector(".stream-progress");
    expect(root).toHaveClass("stream-progress--skeleton");
    expect(container.querySelector(".stream-progress__skeleton-track")).toBeInTheDocument();
    expect(container.querySelector(".stream-progress__skeleton-meta")).toBeInTheDocument();
  });

  it("does not render live progress elements when loading", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    expect(container.querySelector(".stream-progress__track")).not.toBeInTheDocument();
    expect(container.querySelector(".stream-progress__fill")).not.toBeInTheDocument();
    expect(container.querySelector(".stream-progress__meta")).not.toBeInTheDocument();
    expect(container.querySelector(".stream-progress__hints")).not.toBeInTheDocument();
  });

  it("does not render empty state when loading is true even for empty status", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress status="empty" loading={true} />
    );

    expect(container.querySelector(".stream-progress--skeleton")).toBeInTheDocument();
    expect(container.querySelector(".empty-state")).not.toBeInTheDocument();
  });

  it("marks the wrapper as aria-busy for assistive technology", () => {
    mockMatchMedia(false);
    render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    const root = screen.getByLabelText("Stream progress is loading");
    expect(root).toHaveAttribute("aria-busy", "true");
  });

  it("skeleton elements are aria-hidden from screen readers", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    const meta = container.querySelector(".stream-progress__skeleton-meta");
    expect(meta).toHaveAttribute("aria-hidden", "true");

    // Skeleton component itself is aria-hidden
    const skeletons = container.querySelectorAll(".skeleton");
    skeletons.forEach((sk) => {
      expect(sk).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("prevents user interaction on skeleton via CSS class", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    const root = container.querySelector(".stream-progress--skeleton")!;
    expect(root).toBeInTheDocument();
    // The CSS rule is defined in globals.css (verified in design-token tests below)
    expect(root).toHaveClass("stream-progress--skeleton");
  });

  it("applies className prop alongside skeleton class", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        className="stream-row__progress"
      />
    );

    const root = container.querySelector(".stream-progress");
    expect(root).toHaveClass("stream-progress--skeleton");
    expect(root).toHaveClass("stream-row__progress");
  });

  it("does not render skeleton when loading is false (normal render)", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress status="active" accruedAmount={50} totalAmount={100} />
    );

    expect(container.querySelector(".stream-progress--skeleton")).not.toBeInTheDocument();
    expect(container.querySelector(".stream-progress__skeleton-track")).not.toBeInTheDocument();
    expect(container.querySelector(".stream-progress__track")).toBeInTheDocument();
  });

  it("skeleton meta element uses the same gap token as the non-loading meta", () => {
    mockMatchMedia(false);
    const { container } = render(
      <StreamProgress
        status="active"
        loading={true}
        accruedAmount={50}
        totalAmount={100}
      />
    );

    const meta = container.querySelector(".stream-progress__skeleton-meta")!;
    expect(meta).toBeInTheDocument();
    // Mirrors .stream-progress__meta layout (verified in design-token tests via CSS)
    expect(meta).not.toHaveClass("stream-progress__meta");
    expect(meta.querySelectorAll(".skeleton").length).toBe(2);
  });
});


// ── Empty state tests ───────────────────────────────────────────────────────

describe("StreamProgress empty state", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("renders empty state when status is empty", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="empty" />);

    expect(screen.getByText("Stream Progress")).toBeInTheDocument();
    expect(screen.getByText("No active stream found")).toBeInTheDocument();
    expect(
      screen.getByText(
        "There is no stream progress to track. Start a stream to see live accumulation."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a stream" })).toBeInTheDocument();
  });

  it("renders empty state when isEmpty prop is true", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" isEmpty={true} />);

    expect(screen.getByText("Stream Progress")).toBeInTheDocument();
    expect(screen.getByText("No active stream found")).toBeInTheDocument();
  });

  it("renders empty state with custom copy and handles action click", () => {
    mockMatchMedia(false);
    const onAction = jest.fn();
    render(
      <StreamProgress
        status="empty"
        emptyEyebrow="My Custom Eyebrow"
        emptyTitle="My Custom Title"
        emptyDescription="My Custom Description"
        emptyActionLabel="My Custom Action"
        onEmptyAction={onAction}
      />
    );

    expect(screen.getByText("My Custom Eyebrow")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My Custom Title" })).toBeInTheDocument();
    expect(screen.getByText("My Custom Description")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "My Custom Action" });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

// ── Keyboard shortcut hint tests ─────────────────────────────────────────────

describe("StreamProgress keyboard shortcut hints", () => {
  afterEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });

  it("renders a toggle button for keyboard shortcuts", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const toggle = screen.getByTestId("stream-progress-kbd-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("Keyboard shortcuts");
  });

  it("hints are hidden by default", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    expect(screen.queryByTestId("stream-progress-kbd-hints")).not.toBeInTheDocument();
  });

  it("toggle button has aria-expanded=false by default", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const toggle = screen.getByTestId("stream-progress-kbd-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows hints when toggle is clicked", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const toggle = screen.getByTestId("stream-progress-kbd-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("stream-progress-kbd-hints")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("hides hints when toggle is clicked again", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const toggle = screen.getByTestId("stream-progress-kbd-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("stream-progress-kbd-hints")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("stream-progress-kbd-hints")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows Space shortcut for active streams", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    fireEvent.click(screen.getByTestId("stream-progress-kbd-toggle"));
    expect(screen.getByText("Space")).toBeInTheDocument();
    expect(screen.getByText("Pause / resume")).toBeInTheDocument();
  });

  it("shows Space shortcut for paused streams", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="paused" accruedAmount={50} totalAmount={100} />);
    fireEvent.click(screen.getByTestId("stream-progress-kbd-toggle"));
    expect(screen.getByText("Space")).toBeInTheDocument();
    expect(screen.getByText("Pause / resume")).toBeInTheDocument();
  });

  it("shows Enter shortcut for draft streams", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="draft" />);
    fireEvent.click(screen.getByTestId("stream-progress-kbd-toggle"));
    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByText("Start stream")).toBeInTheDocument();
  });

  it("does not show Space shortcut for ended streams", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="ended" />);
    fireEvent.click(screen.getByTestId("stream-progress-kbd-toggle"));
    expect(screen.queryByText("Space")).not.toBeInTheDocument();
    expect(screen.queryByText("Pause / resume")).not.toBeInTheDocument();
  });

  it("always shows Esc and Ctrl+K shortcuts", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    fireEvent.click(screen.getByTestId("stream-progress-kbd-toggle"));
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getByText("Deselect")).toBeInTheDocument();
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText("K")).toBeInTheDocument();
    expect(screen.getByText("Command palette")).toBeInTheDocument();
  });

  it("hints section is aria-hidden", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const hintsSection = screen.getByTestId("stream-progress-kbd-toggle").parentElement;
    expect(hintsSection).toHaveAttribute("aria-hidden", "true");
  });

  it("toggle button is keyboard focusable", () => {
    mockMatchMedia(false);
    render(<StreamProgress status="active" accruedAmount={50} totalAmount={100} />);
    const toggle = screen.getByTestId("stream-progress-kbd-toggle");
    expect(toggle).toHaveAttribute("type", "button");
    toggle.focus();
    expect(toggle).toHaveFocus();
  });
});
