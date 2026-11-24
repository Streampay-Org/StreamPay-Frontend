/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen, waitFor } = require("@testing-library/react") as any;
import { InlineHelp } from "./InlineHelp";

function getOverlay(): HTMLElement {
  const overlay = document.querySelector('div[data-inline-help-overlay="true"]');
  if (!overlay) {
    throw new Error("Expected inline-help overlay to be present.");
  }
  return overlay as HTMLElement;
}

function renderHelp() {
  const utils = render(
    <div>
      <span>Outside content</span>
      <InlineHelp title="Stream Rate Help">
        <p>Help content here</p>
        <button type="button">Action in panel</button>
      </InlineHelp>
    </div>,
  );
  return utils;
}

describe("InlineHelp", () => {
  it("renders the trigger button", () => {
    renderHelp();
    expect(screen.getByRole("button", { name: /show help/i })).toBeInTheDocument();
  });

  it("trigger has correct aria attributes when closed", () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: /show help/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");
  });

  it("opens the drawer on trigger click", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    expect(screen.getByRole("dialog", { name: /stream rate help/i })).toBeInTheDocument();
  });

  it("shows the title when open", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    expect(screen.getByRole("heading", { name: /stream rate help/i })).toBeInTheDocument();
  });

  it("shows children when open", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    expect(screen.getByText("Help content here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /action in panel/i })).toBeInTheDocument();
  });

  it("closes on close button click and unmounts after animation", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close help panel/i }));
    fireEvent.animationEnd(getOverlay());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("trigger shows aria-expanded true when open", () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: /show help/i });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape key", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.animationEnd(getOverlay());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when clicking backdrop", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const overlay = getOverlay();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    fireEvent.animationEnd(overlay);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does NOT close when a drag starts inside the dialog and ends on the backdrop", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const dialog = screen.getByRole("dialog");
    const overlay = getOverlay();
    fireEvent.mouseDown(dialog);
    fireEvent.click(overlay);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does NOT close when interacting with content inside the dialog", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const action = screen.getByRole("button", { name: /action in panel/i });
    fireEvent.mouseDown(action);
    fireEvent.click(action);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not render drawer content when closed", () => {
    renderHelp();
    expect(screen.queryByText("Help content here")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog as modal with correct aria attributes", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const dialog = screen.getByRole("dialog");
    const heading = screen.getByRole("heading", { name: /stream rate help/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
  });

  it("moves focus into the dialog on open and restores to trigger on close", async () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: /show help/i });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    fireEvent.animationEnd(getOverlay());
  });

  it("locks body scroll while open", () => {
    renderHelp();
    expect(document.body.style.overflow).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
    fireEvent.animationEnd(getOverlay());
  });

  it("traps Tab and Shift+Tab focus inside the dialog", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /show help/i }));
    const dialog = screen.getByRole("dialog");
    const closeButton = screen.getByRole("button", { name: /close help panel/i });
    const panelAction = screen.getByRole("button", { name: /action in panel/i });
    panelAction.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(panelAction).toHaveFocus();
  });

  it("accepts custom className on the trigger", () => {
    const { container } = render(
      <InlineHelp title="Test" className="my-custom-class">
        <p>Content</p>
      </InlineHelp>,
    );
    const trigger = container.querySelector(".inline-help__trigger");
    expect(trigger).toHaveClass("inline-help__trigger");
    expect(trigger).toHaveClass("my-custom-class");
  });

  it("accepts custom triggerLabel", () => {
    render(
      <InlineHelp title="Test" triggerLabel="Get help">
        <p>Content</p>
      </InlineHelp>,
    );
    expect(screen.getByRole("button", { name: /get help/i })).toBeInTheDocument();
  });

  it("supports multiple open/close cycles", () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: /show help/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.animationEnd(getOverlay());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /close help panel/i }));
    fireEvent.animationEnd(getOverlay());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("re-focuses trigger on second close", async () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: /show help/i });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    fireEvent.animationEnd(getOverlay());
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    fireEvent.animationEnd(getOverlay());
  });
});
