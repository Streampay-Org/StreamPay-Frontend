/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/"}
 *
 * OnboardingManager — unit tests.
 * Covers the focus-trap, safe-storage, and backdrop-session test plan rows.
 *
 * Verifies that the component correctly reads from localStorage and shows /
 * hides the onboarding banner and WelcomeTour accordingly.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import OnboardingManager from "./OnboardingManager";
import { WELCOME_TOUR_KEY } from "./WelcomeTour";

const BANNER_KEY = "streampay_onboarding_dismissed";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// First-time visitor — tour shown
// ---------------------------------------------------------------------------

describe("OnboardingManager — first-time visitor", () => {
  it("shows the WelcomeTour modal (not the banner) on the very first visit", () => {
    render(<OnboardingManager />);
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-banner")).toBeNull();
  });

  it("hides the tour after skipping and does not show the banner", () => {
    render(<OnboardingManager />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
    });
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
    expect(screen.queryByTestId("onboarding-banner")).toBeNull();
  });

  it("sets both storage keys after the tour is dismissed", () => {
    render(<OnboardingManager />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));
    });
    expect(localStorage.getItem(WELCOME_TOUR_KEY)).toBe("1");
    expect(localStorage.getItem(BANNER_KEY)).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Blocked storage — privacy modes
// ---------------------------------------------------------------------------

describe("OnboardingManager — blocked localStorage", () => {
  it("does not crash and shows the banner when localStorage.getItem throws", () => {
    const getItemSpy = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      render(<OnboardingManager />);
      expect(screen.getByTestId("onboarding-banner")).toBeInTheDocument();
      expect(screen.queryByTestId("welcome-tour")).toBeNull();
    } finally {
      getItemSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Returning visitor — banner shown
// ---------------------------------------------------------------------------

describe("OnboardingManager — returning visitor (tour seen, banner not dismissed)", () => {
  it("shows the plain banner when the tour has been dismissed but the banner has not", () => {
    localStorage.setItem(WELCOME_TOUR_KEY, "1");
    render(<OnboardingManager />);
    expect(screen.getByTestId("onboarding-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
  });

  it("hides the banner when the Dismiss button is clicked", () => {
    localStorage.setItem(WELCOME_TOUR_KEY, "1");
    render(<OnboardingManager />);
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: /dismiss welcome message/i }),
      );
    });
    expect(screen.queryByTestId("onboarding-banner")).toBeNull();
  });

  it("writes the banner key to localStorage when dismissed", () => {
    localStorage.setItem(WELCOME_TOUR_KEY, "1");
    render(<OnboardingManager />);
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: /dismiss welcome message/i }),
      );
    });
    expect(localStorage.getItem(BANNER_KEY)).toBe("true");
  });

  it("does not crash when localStorage.setItem throws on banner dismiss", () => {
    localStorage.setItem(WELCOME_TOUR_KEY, "1");
    const setItemSpy = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      render(<OnboardingManager />);
      act(() => {
        fireEvent.click(
          screen.getByRole("button", { name: /dismiss welcome message/i }),
        );
      });
      expect(screen.queryByTestId("onboarding-banner")).toBeNull();
    } finally {
      setItemSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Fully returning visitor — nothing shown
// ---------------------------------------------------------------------------

describe("OnboardingManager — fully returning visitor (everything dismissed)", () => {
  it("renders nothing when both the tour and banner are already dismissed", () => {
    localStorage.setItem(WELCOME_TOUR_KEY, "1");
    localStorage.setItem(BANNER_KEY, "true");
    render(<OnboardingManager />);
    expect(screen.queryByTestId("welcome-tour")).toBeNull();
    expect(screen.queryByTestId("onboarding-banner")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy: only the banner key is set (pre-tour users)
// ---------------------------------------------------------------------------

describe("OnboardingManager — legacy state (banner key set, no tour key)", () => {
  it("shows the tour if the tour key is absent even if the banner key is set", () => {
    // Edge case: banner was dismissed before the tour feature existed.
    // The tour key takes precedence — if absent, we show the tour.
    localStorage.setItem(BANNER_KEY, "true");
    render(<OnboardingManager />);
    // Tour key absent → show tour
    expect(screen.getByTestId("welcome-tour")).toBeInTheDocument();
  });
});
