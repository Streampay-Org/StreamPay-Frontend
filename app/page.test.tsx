/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import Home from "./page";

// OnboardingManager reads localStorage; ensure a clean slate per test.
beforeEach(() => {
  localStorage.clear();
});

describe("Home", () => {
  it("renders the updated stream action heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        name: /manage payment streams with clear, consistent actions/i,
      }),
    ).toBeInTheDocument();
  });

  it("does not rely on manual tab index overrides on interactive elements", () => {
    const { container } = render(<Home />);

    // tabindex="-1" on the dialog container is intentional (programmatic focus
    // management for the WelcomeTour modal). What we guard against is
    // tabindex > 0, which creates an unpredictable tab order.
    const positiveTabIndex = container.querySelectorAll("[tabindex]:not([tabindex='-1'])");
    expect(positiveTabIndex).toHaveLength(0);
  });

  it("renders stream action cards", () => {
    render(<Home />);

    expect(screen.getByRole("region", { name: /start a new payment stream/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /pause an active payment stream/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /withdraw available funds/i })).toBeInTheDocument();
  });

  it("renders clear wallet and stream action CTAs", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /how it works/i })).toBeInTheDocument();
  });

  it("renders the standardized stream action labels", () => {
    render(<Home />);
    for (const action of ["Start", "Pause", "Stop", "Settle", "Withdraw"]) {
      expect(screen.getByRole("heading", { name: action })).toBeInTheDocument();
    }
  });

  it("renders the reusable stream status badge section", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: /stream statuses/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/stream status: active/i)).toHaveLength(2);
    expect(screen.getByLabelText(/stream status: draft/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stream status: paused/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stream status: ended/i)).toBeInTheDocument();
  });

  it("does not import StreamPrimer (unused component removed in issue #85)", () => {
    // The component tree rendered by Home must not contain any element with a
    // role or label associated with StreamPrimer. This guards against the
    // unused import being re-introduced.
    render(<Home />);
    expect(screen.queryByTestId("stream-primer")).toBeNull();
  });
});
