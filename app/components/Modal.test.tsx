import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import Modal from "./Modal";

function ModalHarness() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open modal
      </button>
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Confirm action"
        description="This action cannot be undone."
        footer={
          <button type="button" onClick={() => setIsOpen(false)}>
            Confirm
          </button>
        }
      >
        <button type="button">Focusable action</button>
      </Modal>
    </div>
  );
}

describe("Modal", () => {
  it("opens and closes from user actions", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(screen.getByRole("dialog", { name: /confirm action/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close dialog/i }));
    expect(screen.queryByRole("dialog", { name: /confirm action/i })).not.toBeInTheDocument();
  });

  it("closes on escape and restores focus to the trigger", async () => {
    render(<ModalHarness />);

    const trigger = screen.getByRole("button", { name: /open modal/i });
    trigger.focus();

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: /confirm action/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /confirm action/i })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("locks background scroll while open", () => {
    render(<ModalHarness />);

    fireEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /close dialog/i }));
    expect(document.body.style.overflow).toBe("");
  });
});
