/**
 * @jest-environment jsdom
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { isBrowserOnline, useNetworkStatus } from "./useNetworkStatus";

function Probe() {
  const { isOnline } = useNetworkStatus();
  return <div data-testid="online">{String(isOnline)}</div>;
}

function setNavigatorOnline(onLine: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    value: onLine,
    configurable: true,
  });
}

const ORIGINAL_ONLINE = true;

describe("useNetworkStatus", () => {
  beforeEach(() => {
    setNavigatorOnline(ORIGINAL_ONLINE);
  });

  afterEach(() => {
    setNavigatorOnline(ORIGINAL_ONLINE);
  });

  it("defaults to navigator.onLine when it is true", () => {
    setNavigatorOnline(true);
    render(<Probe />);
    expect(screen.getByTestId("online")).toHaveTextContent("true");
  });

  it("initializes as offline when navigator.onLine is false", () => {
    setNavigatorOnline(false);
    render(<Probe />);
    expect(screen.getByTestId("online")).toHaveTextContent("false");
  });

  it("flips to offline when the offline event fires", () => {
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByTestId("online")).toHaveTextContent("false");
  });

  it("flips back to online when the online event fires", () => {
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByTestId("online")).toHaveTextContent("true");
  });
});

describe("isBrowserOnline", () => {
  it("returns true when the browser reports online", () => {
    setNavigatorOnline(true);
    expect(isBrowserOnline()).toBe(true);
  });

  it("returns false when the browser reports offline", () => {
    setNavigatorOnline(false);
    expect(isBrowserOnline()).toBe(false);
  });
});