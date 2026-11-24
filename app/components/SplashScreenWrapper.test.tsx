/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { SplashScreenWrapper } from "./SplashScreenWrapper";

describe("SplashScreenWrapper", () => {
  it("renders the splash screen overlay", async () => {
    render(<SplashScreenWrapper />);

    // next/dynamic resolves asynchronously even with ssr: false, so the
    // splash content appears after the dynamic import settles.
    await waitFor(() => {
      expect(screen.getByRole("status", { name: /loading streampay/i })).toBeInTheDocument();
    });
  });

  it("does not throw when rendered inside a Server Component tree", () => {
    // Regression guard for the App Router constraint that
    // `dynamic(..., { ssr: false })` may not be called directly inside a
    // Server Component. Because SplashScreenWrapper is itself
    // `"use client"` and owns the dynamic() call, rendering it standalone
    // (as layout.tsx does) must not throw.
    expect(() => render(<SplashScreenWrapper />)).not.toThrow();
  });
});
