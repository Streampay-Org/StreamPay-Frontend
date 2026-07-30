/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen } = require("@testing-library/react") as any;
import { ShortcutsOverlay } from "./ShortcutsOverlay";

function triggerOpen() {
  fireEvent.keyDown(document, { key: "?" });
}

function getDialog(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /keyboard shortcuts/i });
}

function getOverlay(): HTMLElement {
  const overlay = document.body.querySelector(
    'div[data-shortcuts-overlay="true"]'
  );
  if (!overlay) {
    throw new Error("Expected shortcuts overlay to be present.");
  }
  return overlay as HTMLElement;
}

describe("ShortcutsOverlay", () => {
  it("is hidden by default", () => {
    render(<ShortcutsOverlay />);
    expect(getDialog()).not.toBeInTheDocument();
  });

  it("opens on pressing ? key", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(getDialog()).toBeInTheDocument();
    expect(
      screen.getByText("Keyboard Shortcuts")
    ).toBeInTheDocument();
  });

  it("closes on pressing ? key again", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();
    expect(getDialog()).toBeInTheDocument();

    triggerOpen();
    fireEvent.animationEnd(getOverlay());
    expect(getDialog()).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();
    expect(getDialog()).toBeInTheDocument();

    const dialog = getDialog()!;
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.animationEnd(getOverlay());
    expect(getDialog()).not.toBeInTheDocument();
  });

  it("closes on backdrop click", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    const overlay = getOverlay();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    fireEvent.animationEnd(overlay);

    expect(getDialog()).not.toBeInTheDocument();
  });

  it("does NOT close when clicking inside the dialog", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    const dialog = getDialog()!;
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(getDialog()).toBeInTheDocument();
  });

  it("renders all shortcut groups", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
  });

  it("renders shortcut descriptions", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(
      screen.getByText("Show keyboard shortcuts")
    ).toBeInTheDocument();
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
    expect(screen.getByText("Close dialogs")).toBeInTheDocument();
    expect(screen.getByText("Navigate lists")).toBeInTheDocument();
    expect(screen.getByText("Navigate tabs")).toBeInTheDocument();
  });

  it("locks body scroll when open and restores on close", () => {
    render(<ShortcutsOverlay />);
    expect(document.body.style.overflow).toBe("");

    triggerOpen();
    expect(document.body.style.overflow).toBe("hidden");

    const dialog = getDialog()!;
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.animationEnd(getOverlay());
    expect(document.body.style.overflow).toBe("");
  });

  it("renders as an accessible modal dialog labelled by its title", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    const dialog = getDialog()!;
    const title = screen.getByText("Keyboard Shortcuts");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", title.id);
  });

  it("renders a close button", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(
      screen.getByRole("button", { name: /close shortcuts overlay/i })
    ).toBeInTheDocument();
  });

  it("closes when clicking close button", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();
    expect(getDialog()).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /close shortcuts overlay/i })
    );
    fireEvent.animationEnd(getOverlay());
    expect(getDialog()).not.toBeInTheDocument();
  });

  it("shows toggle hint in footer", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(screen.getByText(/press/i)).toBeInTheDocument();
    // The footer should mention that ? toggles the overlay
    const footerText = document.body.textContent || "";
    expect(footerText).toContain("?");
  });
});
