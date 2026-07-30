/**
 * @jest-environment jsdom
 *
 * SplashScreen — unit tests for timing and render behaviour.
 *
 * Issue #85: The minimum display delay was reduced from 2400 ms to 400 ms
 * and the fade-out from 600 ms to 300 ms. These tests act as regression
 * guards so the delay cannot quietly creep back up.
 */

import { act, render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import SplashScreen, {
  SPLASH_DISPLAY_MS,
  SPLASH_FADE_MS,
} from "./SplashScreen";

describe("SplashScreen timing constants (issue #85)", () => {
  it("SPLASH_DISPLAY_MS is at most 600 ms", () => {
    expect(SPLASH_DISPLAY_MS).toBeLessThanOrEqual(600);
  });

  it("SPLASH_FADE_MS is at most 400 ms", () => {
    expect(SPLASH_FADE_MS).toBeLessThanOrEqual(400);
  });

  it("total blocking time (SPLASH_DISPLAY_MS + SPLASH_FADE_MS) is under 1 second", () => {
    expect(SPLASH_DISPLAY_MS + SPLASH_FADE_MS).toBeLessThan(1000);
  });
});

describe("SplashScreen render", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("is visible on initial mount", () => {
    render(<SplashScreen />);
    expect(screen.getByRole("status", { name: /loading streampay/i })).toBeInTheDocument();
  });

  it("shows the StreamPay logo image", () => {
    render(<SplashScreen />);
    expect(screen.getByAltText(/streampay logo/i)).toBeInTheDocument();
  });

  it("begins fade-out after SPLASH_DISPLAY_MS", () => {
    const { container } = render(<SplashScreen />);
    act(() => {
      jest.advanceTimersByTime(SPLASH_DISPLAY_MS);
    });
    expect(container.querySelector(".splash-screen--exit")).not.toBeNull();
  });

  it("unmounts after SPLASH_DISPLAY_MS + SPLASH_FADE_MS", () => {
    render(<SplashScreen />);
    act(() => {
      jest.advanceTimersByTime(SPLASH_DISPLAY_MS + SPLASH_FADE_MS + 1);
    });
    expect(screen.queryByRole("status", { name: /loading streampay/i })).toBeNull();
  });

  it("registers preference for reduced motion and shows static splash", () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation(query => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    
    const { container } = render(<SplashScreen />);
    
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    
    // Ensure animated elements are excluded
    expect(container.querySelector('.splash-orb')).toBeNull();
    expect(container.querySelector('.splash-logo-glow')).toBeNull();
    expect(container.querySelector('.splash-loader')).toBeNull();
    
    // Core content should still be present
    expect(screen.getByAltText(/streampay logo/i)).toBeInTheDocument();
  });
});
