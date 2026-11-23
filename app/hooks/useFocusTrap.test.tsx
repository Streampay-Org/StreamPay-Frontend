import React, { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusTrap } from "./useFocusTrap";

interface HarnessProps {
  isActive: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
  empty?: boolean;
  includeSkipped?: boolean;
  showOpener?: boolean;
}

function FocusTrapHarness({
  isActive,
  onEscape,
  restoreFocus,
  empty = false,
  includeSkipped = false,
  showOpener = true,
}: HarnessProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap({
    isActive,
    containerRef,
    onEscape,
    restoreFocus,
  });

  return (
    <div>
      {showOpener && <button type="button">Outside Opener</button>}
      <button type="button">Outside Other</button>
      <div
        ref={containerRef}
        tabIndex={-1}
        data-testid="trap-container"
        role="dialog"
        aria-label="Test Dialog"
      >
        {!empty && (
          <>
            {includeSkipped && (
              <>
                <button type="button" hidden>
                  Hidden First
                </button>
                <button type="button" disabled>
                  Disabled First
                </button>
                <button type="button" aria-hidden="true">
                  Aria Hidden First
                </button>
              </>
            )}
            <button type="button">First</button>
            <button type="button">Second</button>
            <button type="button">Third</button>
            {includeSkipped && (
              <>
                <button type="button" hidden>
                  Hidden Last
                </button>
                <button type="button" disabled>
                  Disabled Last
                </button>
                <button type="button" aria-hidden="true">
                  Aria Hidden Last
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves initial focus into the container when focus is outside", () => {
    const { rerender } = render(<FocusTrapHarness isActive={false} />);
    const opener = screen.getByRole("button", { name: "Outside Opener" });
    opener.focus();
    expect(opener).toHaveFocus();

    rerender(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();
  });

  it("keeps focus on an already-focused descendant on activation", () => {
    const { rerender } = render(<FocusTrapHarness isActive={false} />);
    const second = screen.getByRole("button", { name: "Second" });
    second.focus();
    expect(second).toHaveFocus();

    rerender(<FocusTrapHarness isActive={true} />);
    expect(second).toHaveFocus();
  });

  it("wraps Tab from last element to first and Shift+Tab from first to last", async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness isActive={true} />);

    const first = screen.getByRole("button", { name: "First" });
    const third = screen.getByRole("button", { name: "Third" });

    third.focus();
    expect(third).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(third).toHaveFocus();
  });

  it("moves focus to the last element on Shift+Tab from the container itself", async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness isActive={true} />);

    const container = screen.getByTestId("trap-container");
    const third = screen.getByRole("button", { name: "Third" });
    expect(container).toHaveFocus();

    await user.tab({ shift: true });
    expect(third).toHaveFocus();
  });

  it("keeps focus on the container when there are no focusable descendants", async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness isActive={true} empty={true} />);

    const container = screen.getByTestId("trap-container");
    expect(container).toHaveFocus();

    await user.tab();
    expect(container).toHaveFocus();

    await user.tab({ shift: true });
    expect(container).toHaveFocus();
  });

  it("skips hidden, disabled, and aria-hidden elements during wrap-around", async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness isActive={true} includeSkipped={true} />);

    const first = screen.getByRole("button", { name: "First" });
    const third = screen.getByRole("button", { name: "Third" });

    third.focus();
    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(third).toHaveFocus();
  });

  it("redirects focusin on an outside element back into the container", () => {
    render(<FocusTrapHarness isActive={true} />);

    const first = screen.getByRole("button", { name: "First" });
    const outsideOther = screen.getByRole("button", { name: "Outside Other" });

    outsideOther.focus();
    expect(first).toHaveFocus();
  });

  it("redirects focusin on an outside element to the container when empty", () => {
    render(<FocusTrapHarness isActive={true} empty={true} />);

    const container = screen.getByTestId("trap-container");
    const outsideOther = screen.getByRole("button", { name: "Outside Other" });

    outsideOther.focus();
    expect(container).toHaveFocus();
  });

  it("calls onEscape when Escape is pressed and does nothing when onEscape is undefined", async () => {
    const user = userEvent.setup();
    const onEscape = jest.fn();

    const { rerender } = render(
      <FocusTrapHarness isActive={true} onEscape={onEscape} />,
    );

    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);

    rerender(<FocusTrapHarness isActive={true} onEscape={undefined} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("uses the latest onEscape callback without resetting focus when its identity changes", async () => {
    const user = userEvent.setup();
    const firstOnEscape = jest.fn();
    const secondOnEscape = jest.fn();

    const { rerender } = render(
      <FocusTrapHarness isActive={true} onEscape={firstOnEscape} />,
    );

    const secondButton = screen.getByRole("button", { name: "Second" });
    secondButton.focus();
    expect(secondButton).toHaveFocus();

    rerender(<FocusTrapHarness isActive={true} onEscape={secondOnEscape} />);
    expect(secondButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(firstOnEscape).not.toHaveBeenCalled();
    expect(secondOnEscape).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener on deactivate and on unmount", () => {
    const { rerender, unmount } = render(<FocusTrapHarness isActive={false} />);
    const opener = screen.getByRole("button", { name: "Outside Opener" });
    opener.focus();

    rerender(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    rerender(<FocusTrapHarness isActive={false} />);
    expect(opener).toHaveFocus();

    // Activate again and unmount while active
    rerender(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    // Keep opener in DOM while unmounting only the trap via a separate wrapper
    unmount();
  });

  it("restores focus to an external opener when the trap component unmounts", () => {
    const externalOpener = document.createElement("button");
    externalOpener.textContent = "External Opener";
    document.body.appendChild(externalOpener);
    externalOpener.focus();

    const { unmount } = render(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    unmount();
    expect(externalOpener).toHaveFocus();

    document.body.removeChild(externalOpener);
  });

  it("does not restore focus when restoreFocus is false", () => {
    const { rerender } = render(
      <FocusTrapHarness isActive={false} restoreFocus={false} />,
    );
    const opener = screen.getByRole("button", { name: "Outside Opener" });
    opener.focus();

    rerender(<FocusTrapHarness isActive={true} restoreFocus={false} />);
    const container = screen.getByTestId("trap-container");
    expect(container).toHaveFocus();

    rerender(<FocusTrapHarness isActive={false} restoreFocus={false} />);
    expect(opener).not.toHaveFocus();
    expect(container).toHaveFocus();
  });

  it("skips focus restoration when the opener was removed from the DOM", () => {
    const { rerender } = render(
      <FocusTrapHarness isActive={false} showOpener={true} />,
    );
    const opener = screen.getByRole("button", { name: "Outside Opener" });
    opener.focus();

    rerender(<FocusTrapHarness isActive={true} showOpener={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    // Remove the opener while trap is active, then deactivate
    rerender(<FocusTrapHarness isActive={true} showOpener={false} />);
    expect(opener.isConnected).toBe(false);

    expect(() => {
      rerender(<FocusTrapHarness isActive={false} showOpener={false} />);
    }).not.toThrow();
    expect(document.activeElement).not.toBe(opener);
  });

  it("handles toggling isActive repeatedly", () => {
    const { rerender } = render(<FocusTrapHarness isActive={false} />);
    const opener = screen.getByRole("button", { name: "Outside Opener" });
    const outsideOther = screen.getByRole("button", { name: "Outside Other" });

    opener.focus();
    rerender(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    rerender(<FocusTrapHarness isActive={false} />);
    expect(opener).toHaveFocus();

    outsideOther.focus();
    rerender(<FocusTrapHarness isActive={true} />);
    expect(screen.getByTestId("trap-container")).toHaveFocus();

    rerender(<FocusTrapHarness isActive={false} />);
    expect(outsideOther).toHaveFocus();
  });

  it("removes document listeners when deactivated or unmounted", () => {
    const addSpy = jest.spyOn(document, "addEventListener");
    const removeSpy = jest.spyOn(document, "removeEventListener");
    const onEscape = jest.fn();

    const { rerender, unmount } = render(
      <FocusTrapHarness isActive={true} onEscape={onEscape} />,
    );

    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("focusin", expect.any(Function));

    rerender(<FocusTrapHarness isActive={false} onEscape={onEscape} />);

    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("focusin", expect.any(Function));

    // Pressing Escape or focusing outside while inactive should not trigger trap
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();

    const outsideOther = screen.getByRole("button", { name: "Outside Other" });
    outsideOther.focus();
    expect(outsideOther).toHaveFocus();

    // Re-activate then unmount and confirm listeners are removed again
    rerender(<FocusTrapHarness isActive={true} onEscape={onEscape} />);
    removeSpy.mockClear();
    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("focusin", expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
