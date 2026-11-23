/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen } = require("@testing-library/react") as any;
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SHORTCUTS, getShortcut } from "@/lib/shortcuts";

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

describe("ShortcutsOverlay — registry parity (issue #1649)", () => {
  it("renders exactly one row per shortcut in the shared registry", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    for (const shortcut of SHORTCUTS) {
      const row = document.body.querySelector(
        `[data-shortcut-id="${shortcut.id}"]`
      );
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute("data-shortcut-context", shortcut.context);
    }

    const rows = document.body.querySelectorAll("[data-shortcut-id]");
    expect(rows).toHaveLength(SHORTCUTS.length);
  });

  it("labels the form shortcuts with the 'Create stream form' context", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    expect(screen.getByText("Create stream form")).toBeInTheDocument();
    expect(screen.getByText("Receipt card")).toBeInTheDocument();

    const recipientRow = document.body.querySelector(
      '[data-shortcut-id="create-stream-form.focus-recipient"]'
    ) as HTMLElement;
    const amountRow = document.body.querySelector(
      '[data-shortcut-id="create-stream-form.focus-amount"]'
    ) as HTMLElement;

    expect(recipientRow).not.toBeNull();
    expect(amountRow).not.toBeNull();
    expect(recipientRow.getAttribute("data-shortcut-context")).toBe(
      "Create stream form"
    );
    expect(amountRow.getAttribute("data-shortcut-context")).toBe(
      "Create stream form"
    );
    expect(recipientRow.textContent).toContain("Alt");
    expect(recipientRow.textContent).toContain("R");
    expect(amountRow.textContent).toContain("Alt");
    expect(amountRow.textContent).toContain("A");
  });

  it("renders keys and descriptions from the registry, not a local copy", () => {
    render(<ShortcutsOverlay />);
    triggerOpen();

    const shortcut = getShortcut("global.command-palette");
    const row = document.body.querySelector(
      '[data-shortcut-id="global.command-palette"]'
    ) as HTMLElement;

    expect(row.textContent).toContain(shortcut.description);
    expect(row.textContent).toContain(shortcut.keys[0]);
    expect(row.textContent).toContain(shortcut.keys[1]);
  });
});
