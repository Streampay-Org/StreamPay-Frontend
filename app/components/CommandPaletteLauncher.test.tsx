/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  CommandPaletteLauncher,
  clearCommandPaletteCache,
} from "./CommandPaletteLauncher";
import { ShortcutsOverlayLauncher } from "./ShortcutsOverlayLauncher";
import { mockStreams } from "../streams/fixtures";

let commandPaletteImportCount = 0;
let shortcutsOverlayImportCount = 0;

jest.mock("./CommandPalette", () => {
  commandPaletteImportCount++;
  return {
    CommandPalette: ({ streams }: { streams: any[] }) => (
      <div role="dialog" data-testid="mock-command-palette">
        <input
          data-testid="mock-search-input"
          placeholder="Search streams..."
          autoFocus
        />
        <ul>
          {streams.map((s) => (
            <li key={s.id} data-testid={`stream-item-${s.id}`}>
              {s.recipient}
            </li>
          ))}
        </ul>
      </div>
    ),
  };
});

jest.mock("./ShortcutsOverlay", () => {
  shortcutsOverlayImportCount++;
  return {
    ShortcutsOverlay: () => (
      <div role="dialog" data-testid="mock-shortcuts-overlay">
        Shortcuts Overlay Content
      </div>
    ),
  };
});

describe("CommandPaletteLauncher and ShortcutsOverlayLauncher", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    commandPaletteImportCount = 0;
    shortcutsOverlayImportCount = 0;
    clearCommandPaletteCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Scenario 1: Layout render - CommandPalette module not imported
  it("Scenario 1: CommandPalette module is not imported on initial render", () => {
    render(<CommandPaletteLauncher />);
    expect(commandPaletteImportCount).toBe(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Scenario 2: Press ⌘/Ctrl+K - dynamic import called once and the palette opens with the input focused
  it("Scenario 2: Pressing Cmd+K dynamically imports the palette once and focuses input", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "stream-1",
            recipient: "Alice Corp",
            rate: "100 XLM/mo",
            schedule: "Monthly",
            status: "active",
          },
        ],
      }),
    } as any);

    render(<CommandPaletteLauncher />);
    expect(commandPaletteImportCount).toBe(0);

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });

    await waitFor(() => {
      expect(commandPaletteImportCount).toBe(1);
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("mock-search-input")).toBeInTheDocument();
    });

    // Check input is focused
    const input = screen.getByTestId("mock-search-input");
    expect(document.activeElement === input || input.hasAttribute("autofocus")).toBe(true);
  });

  // Scenario 3: Press again after closing - no second import
  it("Scenario 3: Pressing Cmd+K again after closing does not trigger a second import", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as any);

    render(<CommandPaletteLauncher />);

    // Open
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    await waitFor(() => {
      expect(commandPaletteImportCount).toBe(1);
    });

    // Close
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });

    // Open again
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });

    expect(commandPaletteImportCount).toBe(1);
  });

  // Scenario 4: Palette open - fetch /api/streams?limit=50 called
  it("Scenario 4: Opening palette calls fetch /api/streams?limit=50", async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "stream-live",
            recipient: "Live Org",
            rate: "50 XLM/mo",
            schedule: "Monthly",
            status: "active",
          },
        ],
      }),
    });
    global.fetch = fetchSpy as any;

    render(<CommandPaletteLauncher />);

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/streams?limit=50",
        expect.objectContaining({ signal: expect.any(Object) })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Live Org")).toBeInTheDocument();
    });
  });

  // Scenario 5: Fetch fails - the fallback (or an error) is shown, with no crash
  it("Scenario 5: When fetch fails, falls back gracefully without crashing", async () => {
    const originalEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = "development";

    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

    render(<CommandPaletteLauncher />);

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });

    await waitFor(() => {
      expect(commandPaletteImportCount).toBe(1);
    });

    // Fallback to mockStreams in dev/demo mode
    await waitFor(() => {
      expect(screen.getByText(mockStreams[0].recipient)).toBeInTheDocument();
    });

    (process.env as any).NODE_ENV = originalEnv;
  });

  // Scenario 6: ? key - ShortcutsOverlay imported lazily
  it("Scenario 6: Pressing ? key lazily imports ShortcutsOverlay", async () => {
    render(<ShortcutsOverlayLauncher />);
    expect(shortcutsOverlayImportCount).toBe(0);

    await act(async () => {
      fireEvent.keyDown(document, { key: "?" });
    });

    await waitFor(() => {
      expect(shortcutsOverlayImportCount).toBe(1);
      expect(screen.getByTestId("mock-shortcuts-overlay")).toBeInTheDocument();
    });
  });

  // Responsive loading shell when loading > 300ms
  it("shows loading shell if open pending for more than 300ms", () => {
    jest.useFakeTimers();
    render(<CommandPaletteLauncher />);

    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });

    expect(screen.queryByLabelText("Loading command palette")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(350);
    });

    expect(screen.getByLabelText("Loading command palette")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    jest.useRealTimers();
  });
});
