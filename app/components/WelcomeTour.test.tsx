/**
 * @jest-environment jsdom
 *
 * WelcomeTour — unit tests.
 *
 * Verifies rendering, step navigation, keyboard handling, localStorage
 * persistence, the onDismiss callback, and accessibility requirements.
 */

import { act, fireEvent, render } from "@testing-library/react";
const { screen, within } = require("@testing-library/react") as any;
import { WelcomeTour, TOUR_STEPS, WELCOME_TOUR_KEY } from "./WelcomeTour";

const TEST_KEY = "test:welcome-tour";

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe("WelcomeTour — visibility", () => {
  it("shows the tour when the storage key is absent", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();
  });

  it("does not render when the storage key is already set", () => {
    localStorage.setItem(TEST_KEY, "1");
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
  });

  it("uses WELCOME_TOUR_KEY as the default storage key", () => {
    render(<WelcomeTour />);
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();

    // Key should NOT have been written just from rendering.
    expect(localStorage.getItem(WELCOME_TOUR_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe("WelcomeTour — initial render", () => {
  it("renders a dialog with aria-modal", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders the first step title and body", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
    expect(screen.getByText(TOUR_STEPS[0].body)).toBeInTheDocument();
  });

  it("shows 'Step 1 of N' counter", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(
      screen.getByText(`Step 1 of ${TOUR_STEPS.length}`),
    ).toBeInTheDocument();
  });

  it("renders a 'Next' button (not 'Get started') on the first step", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /get started/i }),
    ).toBeNull();
  });

  it("does not render a 'Back' button on the first step", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("renders a 'Skip tour' button", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    expect(
      screen.getByRole("button", { name: /skip tour/i }),
    ).toBeInTheDocument();
  });

  it("renders step indicator dots equal to the number of steps", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    const dots = screen.getAllByRole("tab");
    expect(dots).toHaveLength(TOUR_STEPS.length);
  });

  it("marks the first dot as selected", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    const dots = screen.getAllByRole("tab");
    expect(dots[0]).toHaveAttribute("aria-selected", "true");
    expect(dots[1]).toHaveAttribute("aria-selected", "false");
  });
});

// ---------------------------------------------------------------------------
// Navigation — Next / Back
// ---------------------------------------------------------------------------

describe("WelcomeTour — step navigation", () => {
  it("advances to the next step when 'Next' is clicked", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    });
    expect(screen.getByText(TOUR_STEPS[1].title)).toBeInTheDocument();
    expect(screen.getByText(`Step 2 of ${TOUR_STEPS.length}`)).toBeInTheDocument();
  });

  it("shows a 'Back' button on step 2+", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    });
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });

  it("goes back to the previous step when 'Back' is clicked", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /back/i }));
    });
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
  });

  it("updates the active dot when navigating", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    });
    const dots = screen.getAllByRole("tab");
    expect(dots[0]).toHaveAttribute("aria-selected", "false");
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to a step when a dot is clicked", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    const dots = screen.getAllByRole("tab");
    act(() => {
      fireEvent.click(dots[2]);
    });
    expect(screen.getByText(TOUR_STEPS[2].title)).toBeInTheDocument();
  });

  it("shows 'Get started' on the last step", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId("welcome-tour-next"));
      });
    }
    expect(
      screen.getByRole("button", { name: /get started/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

describe("WelcomeTour — dismissal", () => {
  it("hides the tour when 'Skip tour' is clicked", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
    });
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
  });

  it("writes to localStorage when skipping", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
    });
    expect(localStorage.getItem(TEST_KEY)).toBe("1");
  });

  it("hides the tour when 'Get started' is clicked on the last step", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId("welcome-tour-next"));
      });
    }
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    });
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
    expect(localStorage.getItem(TEST_KEY)).toBe("1");
  });

  it("calls onDismiss when the tour is skipped", () => {
    const onDismiss = jest.fn();
    render(<WelcomeTour storageKey={TEST_KEY} onDismiss={onDismiss} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when 'Get started' is clicked", () => {
    const onDismiss = jest.fn();
    render(<WelcomeTour storageKey={TEST_KEY} onDismiss={onDismiss} />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId("welcome-tour-next"));
      });
    }
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses when the backdrop is clicked", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByTestId("welcome-tour-overlay"));
    });
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
  });

  it("does NOT dismiss when clicking inside the dialog card", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.click(screen.getByTestId("welcome-tour"));
    });
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

describe("WelcomeTour — keyboard navigation", () => {
  it("dismisses on Escape", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("welcome-tour"), { key: "Escape" });
    });
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
  });

  it("advances on ArrowRight", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("welcome-tour"), {
        key: "ArrowRight",
      });
    });
    expect(screen.getByText(TOUR_STEPS[1].title)).toBeInTheDocument();
  });

  it("goes back on ArrowLeft", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    // Move to step 2 first
    act(() => {
      fireEvent.keyDown(screen.getByTestId("welcome-tour"), {
        key: "ArrowRight",
      });
    });
    act(() => {
      fireEvent.keyDown(screen.getByTestId("welcome-tour"), {
        key: "ArrowLeft",
      });
    });
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
  });

  it("does not go before the first step on ArrowLeft", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("welcome-tour"), {
        key: "ArrowLeft",
      });
    });
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
  });

  it("does not go past the last step on ArrowRight", () => {
    render(<WelcomeTour storageKey={TEST_KEY} />);
    for (let i = 0; i < TOUR_STEPS.length + 2; i++) {
      act(() => {
        fireEvent.keyDown(screen.getByTestId("welcome-tour"), {
          key: "ArrowRight",
        });
      });
    }
    // Should still be visible (ArrowRight doesn't dismiss — only the button does)
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();
    expect(
      screen.getByText(TOUR_STEPS[TOUR_STEPS.length - 1].title),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Content integrity
// ---------------------------------------------------------------------------

describe("WelcomeTour — content", () => {
  it("TOUR_STEPS contains at least 3 steps", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(3);
  });

  it("every step has a non-empty id, title, and body", () => {
    for (const step of TOUR_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.body).toBeTruthy();
    }
  });

  it("step ids are all unique", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
