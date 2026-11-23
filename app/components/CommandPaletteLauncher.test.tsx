/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPaletteLauncher } from "./CommandPaletteLauncher";
import { ShortcutsOverlayLauncher } from "./ShortcutsOverlayLauncher";

const mockLoaded = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("./CommandPalette", () => {
  mockLoaded("palette");
  return jest.requireActual("./CommandPalette");
});
jest.mock("./ShortcutsOverlay", () => {
  mockLoaded("overlay");
  return jest.requireActual("./ShortcutsOverlay");
});

const loadCount = (name: string) =>
  mockLoaded.mock.calls.filter((c) => c[0] === name).length;

/** Advance the clock past the cache TTL so each test starts with an empty cache. */
let fakeNow = 1_000_000;
function setup() {
  mockLoaded.mockClear();
  const searchInput = () => screen.queryByPlaceholderText(/search streams/i);
  return { render, screen, fireEvent, waitFor, CommandPaletteLauncher, ShortcutsOverlayLauncher, searchInput };
}

beforeEach(() => {
  document.body.innerHTML = "";
  fakeNow += 60_000;
  jest.spyOn(Date, "now").mockReturnValue(fakeNow);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [
        { id: "s1", recipient: "Zed", rate: "1 XLM / day", schedule: "daily", status: "active" },
      ],
    }),
  }) as unknown as typeof fetch;
});

describe("CommandPaletteLauncher", () => {
  it("does not load the palette on render", () => {
    const { render, searchInput, CommandPaletteLauncher } = setup();
    render(<CommandPaletteLauncher />);
    expect(loadCount("palette")).toBe(0);
    expect(searchInput()).toBeNull();
  });

  it("loads once on Ctrl+K, focuses input, fetches streams, and reuses the chunk", async () => {
    const { render, screen, fireEvent, waitFor, searchInput, CommandPaletteLauncher } = setup();
    render(<CommandPaletteLauncher />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(searchInput()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(searchInput()));
    expect(global.fetch).toHaveBeenCalledWith("/api/streams?limit=50", expect.anything());
    expect(await screen.findByText("Zed")).toBeTruthy();
    expect(loadCount("palette")).toBe(1);

    fireEvent.keyDown(searchInput(), { key: "Escape" });
    await waitFor(() => expect(searchInput()).toBeNull());
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(searchInput()).not.toBeNull());
    expect(loadCount("palette")).toBe(1);
  });

  it("falls back to demo data when the fetch fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
    const { render, screen, fireEvent, CommandPaletteLauncher } = setup();
    render(<CommandPaletteLauncher />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByText("Ada Creative Studio")).toBeTruthy();
  });
});

describe("ShortcutsOverlayLauncher", () => {
  it("loads the overlay lazily on the question-mark key", async () => {
    const { render, screen, fireEvent, waitFor, ShortcutsOverlayLauncher } = setup();
    render(<ShortcutsOverlayLauncher />);
    expect(loadCount("overlay")).toBe(0);
    fireEvent.keyDown(document.body, { key: "?" });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(loadCount("overlay")).toBe(1);
  });
});
