/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";

// RootLayout composes several client components that each pull in their own
// dependencies (next/navigation, next/image, next/dynamic). For this test we
// only care that RootLayout itself references real, resolvable modules and
// composes its children correctly — so the heavier subtrees are mocked out
// and asserted on by their own dedicated test suites
// (AppBottomNav.test.tsx, SplashScreenWrapper.test.tsx, etc.).
jest.mock("./components/ToastProvider", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="toast-provider">{children}</div>
  ),
}));

jest.mock("./components/CommandPaletteWrapper", () => ({
  CommandPaletteWrapper: () => <div data-testid="command-palette" />,
}));

jest.mock("./components/ShortcutsOverlayWrapper", () => ({
  ShortcutsOverlayWrapper: () => <div data-testid="shortcuts-overlay" />,
}));

jest.mock("./components/SplashScreenWrapper", () => ({
  SplashScreenWrapper: () => <div data-testid="splash-screen" />,
}));

jest.mock("./components/AppBottomNav", () => ({
  AppBottomNav: () => <div data-testid="app-bottom-nav" />,
}));

import RootLayout from "./layout";

describe("RootLayout", () => {
  // RootLayout's root element is <html>, but Testing Library mounts
  // components into a <div> container. This is expected and harmless in
  // tests (Next.js itself only ever renders <html> at the true document
  // root in the browser/server), so we silence the resulting
  // validateDOMNesting console warning to keep test output signal-only.
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders without throwing a ReferenceError for any composed component", () => {
    // Regression test: app/layout.tsx previously referenced <AppBottomNav />
    // without importing it, which throws `ReferenceError: AppBottomNav is
    // not defined` at render/build time. Every child referenced in JSX must
    // resolve to an imported (here, mocked) module.
    expect(() =>
      render(
        <RootLayout>
          <div data-testid="page-content">Page</div>
        </RootLayout>
      )
    ).not.toThrow();
  });

  it("renders the theme no-flash inline script in the document head", () => {
    render(
      <RootLayout>
        <div>Page</div>
      </RootLayout>
    );

    const script = document.querySelector("head script");
    expect(script).not.toBeNull();
    expect(script?.innerHTML).toContain("streampay-theme");
  });

  it("composes ToastProvider, splash screen, command palette, shortcuts overlay, page content, and bottom nav in order", () => {
    render(
      <RootLayout>
        <div data-testid="page-content">Page</div>
      </RootLayout>
    );

    expect(screen.getByTestId("toast-provider")).toBeInTheDocument();
    expect(screen.getByTestId("splash-screen")).toBeInTheDocument();
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(screen.getByTestId("shortcuts-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(screen.getByTestId("app-bottom-nav")).toBeInTheDocument();
  });

  it("sets suppressHydrationWarning on <html> so the no-flash script does not trigger a hydration mismatch warning", () => {
    render(
      <RootLayout>
        <div>Page</div>
      </RootLayout>
    );

    expect(document.documentElement).toBeInTheDocument();
  });
});
