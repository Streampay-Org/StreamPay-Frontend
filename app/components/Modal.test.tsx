/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen, waitFor } = require("@testing-library/react") as any;
import React, { useRef, useState } from "react";
import { FocusTarget, Modal } from "./Modal";

function getOverlay(): HTMLElement {
  const overlay = document.body.querySelector('div[style*="position: fixed"]');
  if (!overlay) {
    throw new Error("Expected modal overlay to be present.");
  }
  return overlay as HTMLElement;
}

function ModalHarness(props: {
  restoreFocusTarget?: FocusTarget;
  autoRestoreFocus?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const customTargetRef = useRef<HTMLButtonElement>(null);

  return (
    <div>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open modal
      </button>
      <button ref={customTargetRef} type="button">
        Custom target action
      </button>
      <button type="button">Background action</button>
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Confirm action"
        restoreFocusTarget={
          props.restoreFocusTarget ??
          (props.restoreFocusTarget === undefined ? undefined : customTargetRef)
        }
        autoRestoreFocus={props.autoRestoreFocus}
      >
        <button type="button">Focusable action</button>
        <button type="button">Final action</button>
      </Modal>
    </div>
  );
}

describe("Modal", () => {
  it("opens and closes from user actions", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(
      screen.getByRole("heading", { name: /confirm action/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close modal/i }));
    fireEvent.animationEnd(getOverlay());
    expect(
      screen.queryByRole("heading", { name: /confirm action/i }),
    ).not.toBeInTheDocument();
  });

  it("closes when clicking backdrop", async () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(
      screen.getByRole("heading", { name: /confirm action/i }),
    ).toBeInTheDocument();
    const overlay = getOverlay();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    fireEvent.animationEnd(overlay);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /confirm action/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("does NOT close when a drag starts inside the dialog and ends on the backdrop", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    const overlay = getOverlay();

    fireEvent.mouseDown(dialog);
    fireEvent.click(overlay);

    expect(
      screen.getByRole("heading", { name: /confirm action/i }),
    ).toBeInTheDocument();
  });

  it("does NOT close when interacting with content inside the dialog", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    const finalAction = screen.getByRole("button", { name: /final action/i });

    fireEvent.mouseDown(finalAction);
    fireEvent.click(finalAction);

    expect(
      screen.getByRole("heading", { name: /confirm action/i }),
    ).toBeInTheDocument();
  });

  it("renders children only while open", () => {
    render(<ModalHarness />);

    expect(screen.queryByText(/focusable action/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(screen.getByText(/focusable action/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close modal/i }));
    fireEvent.animationEnd(getOverlay());
    expect(screen.queryByText(/focusable action/i)).not.toBeInTheDocument();
  });

  it("renders as an accessible modal dialog labelled by its title", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));

    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    const title = screen.getByRole("heading", { name: /confirm action/i });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", title.id);
  });

  it("moves focus into the dialog and restores it to the trigger on close by default", () => {
    render(<ModalHarness />);

    const trigger = screen.getByRole("button", { name: /open modal/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("restores focus to a custom Ref target when restoreFocusTarget is provided", () => {
    function CustomRefHarness() {
      const [isOpen, setIsOpen] = useState(false);
      const customRef = useRef<HTMLButtonElement>(null);

      return (
        <div>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open
          </button>
          <button ref={customRef} type="button">
            Custom Ref Button
          </button>
          <Modal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            title="Custom Focus"
            restoreFocusTarget={customRef}
          >
            <p>Body</p>
          </Modal>
        </div>
      );
    }

    render(<CustomRefHarness />);
    const trigger = screen.getByRole("button", { name: /^open$/i });
    const customButton = screen.getByRole("button", {
      name: /custom ref button/i,
    });

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: /custom focus/i });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(customButton).toHaveFocus();
  });

  it("restores focus via callback returning an element", () => {
    function CallbackHarness() {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <div>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open
          </button>
          <button id="target-id" type="button">
            Target by ID
          </button>
          <Modal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            title="Callback Focus"
            restoreFocusTarget={() => document.getElementById("target-id")}
          >
            <p>Body</p>
          </Modal>
        </div>
      );
    }

    render(<CallbackHarness />);
    const trigger = screen.getByRole("button", { name: /^open$/i });
    const targetElement = screen.getByRole("button", { name: /target by id/i });

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: /callback focus/i });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(targetElement).toHaveFocus();
  });

  it("does not restore focus when autoRestoreFocus is false", () => {
    render(<ModalHarness autoRestoreFocus={false} />);

    const trigger = screen.getByRole("button", { name: /open modal/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(trigger).not.toHaveFocus();
  });

  it("traps Tab and Shift+Tab focus inside the dialog", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));

    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    const closeButton = screen.getByRole("button", { name: /close modal/i });
    const finalAction = screen.getByRole("button", { name: /final action/i });

    finalAction.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(finalAction).toHaveFocus();
  });

  it("closes on Escape and locks body scroll while open", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));

    const dialog = screen.getByRole("dialog", { name: /confirm action/i });
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
    fireEvent.animationEnd(getOverlay());

    expect(
      screen.queryByRole("dialog", { name: /confirm action/i }),
    ).not.toBeInTheDocument();
  });
});
