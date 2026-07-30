/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";

// Use jest.mock with inline factory to avoid hoisting issues
jest.mock("../utils/theme-noflash", () => ({
  __esModule: true,
  setTheme: jest.fn(),
  setHighContrast: jest.fn(),
  getHighContrast: jest.fn(() => false),
  themeNoFlash: jest.fn(),
}));

// Import the mock to get typed references
import * as themeNoFlash from "../utils/theme-noflash";

describe("ThemeToggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const store: Record<string, string> = {};
    const localStorageMock = {
      getItem: jest.fn((key: string) => store[key] ?? null),
      setItem: jest.fn((key: string, value: string) => { store[key] = String(value); }),
      removeItem: jest.fn((key: string) => { delete store[key]; }),
      clear: jest.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
    };
    Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation(_query => ({
        matches: false, media: _query, onchange: null,
        addListener: jest.fn(), removeListener: jest.fn(),
        addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
      })),
    });
    document.documentElement.classList.remove("high-contrast");
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it("renders with system as default", () => {
    render(<ThemeToggle />);
    expect((screen.getByLabelText("System") as HTMLInputElement).checked).toBe(true);
  });

  it("renders with light when in localStorage", () => {
    window.localStorage.setItem("streampay-theme", "light");
    render(<ThemeToggle />);
    expect((screen.getByLabelText("Light") as HTMLInputElement).checked).toBe(true);
  });

  it("calls setTheme when selecting dark", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByLabelText("Dark"));
    expect(themeNoFlash.setTheme).toHaveBeenCalledWith("dark");
  });

  it("removes localStorage when system selected", () => {
    window.localStorage.setItem("streampay-theme", "light");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByLabelText("System"));
    expect(window.localStorage.removeItem).toHaveBeenCalledWith("streampay-theme");
  });

  describe("high-contrast", () => {
    it("renders checkbox", () => {
      render(<ThemeToggle />);
      expect(screen.getByLabelText("High contrast mode")).toBeInTheDocument();
    });

    it("defaults unchecked", () => {
      render(<ThemeToggle />);
      expect((screen.getByLabelText("High contrast mode") as HTMLInputElement).checked).toBe(false);
    });

    it("toggles on click", () => {
      render(<ThemeToggle />);
      const cb = screen.getByLabelText("High contrast mode") as HTMLInputElement;
      fireEvent.click(cb);
      expect(themeNoFlash.setHighContrast).toHaveBeenCalledWith(true);
      fireEvent.click(cb);
      expect(themeNoFlash.setHighContrast).toHaveBeenCalledWith(false);
    });
  });
});
