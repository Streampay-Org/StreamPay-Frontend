/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ShortcutsOverlayLauncher } from "./ShortcutsOverlayLauncher";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function MockShortcutsOverlay() {
      return require("react").createElement("div", {
        role: "dialog",
        "aria-label": "Keyboard shortcuts",
      });
    },
}));

describe("ShortcutsOverlayLauncher", () => {
  it("opens on ? and prevents the browser default", () => {
    const removeEventListener = jest.spyOn(document, "removeEventListener");
    render(<ShortcutsOverlayLauncher />);

    const event = new KeyboardEvent("keydown", {
      key: "?",
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = jest.spyOn(event, "preventDefault");
    fireEvent(document.body, event);

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function)
    );
    removeEventListener.mockRestore();
  });

  it("ignores text-entry targets but opens from a button", () => {
    render(
      <>
        <ShortcutsOverlayLauncher />
        <input aria-label="Input" />
        <textarea aria-label="Textarea" />
        <div aria-label="Editable" contentEditable="true" />
        <button type="button">Button</button>
      </>
    );

    fireEvent.keyDown(screen.getByLabelText("Input"), { key: "?" });
    fireEvent.keyDown(screen.getByLabelText("Textarea"), { key: "?" });
    fireEvent.keyDown(screen.getByLabelText("Editable"), { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button"), { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("ignores other keys and preserves key-based modifier behavior", () => {
    const { unmount } = render(<ShortcutsOverlayLauncher />);

    const otherKey = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = jest.spyOn(otherKey, "preventDefault");
    fireEvent(document.body, otherKey);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(preventDefault).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true, ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    unmount();
  });

  it("removes its key listener when unmounted", () => {
    const removeEventListener = jest.spyOn(document, "removeEventListener");
    const { unmount } = render(<ShortcutsOverlayLauncher />);

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function)
    );
    removeEventListener.mockRestore();
  });
});
