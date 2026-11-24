"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./RowActionsMenu.module.css";

export type RowActionsMenuProps = {
  primaryLabel: string;
  onPrimaryAction: () => void;
  onCancel: () => void;
  cancelDisabled?: boolean;
  disabled?: boolean;
};

/** Accessible, keyboard-operable action menu for a stream row. */
export function RowActionsMenu({
  primaryLabel,
  onPrimaryAction,
  onCancel,
  cancelDisabled = false,
  disabled = false,
}: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]");
    first?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [],
    ).filter((item) => !item.disabled);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[(current + offset + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${primaryLabel} actions`}
        tabIndex={-1}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        Actions
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={`${primaryLabel} actions`}
          className={styles.menu}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              onPrimaryAction();
              close();
            }}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={cancelDisabled}
            onClick={() => {
              onCancel();
              close();
            }}
          >
            Cancel stream
          </button>
        </div>
      )}
    </div>
  );
}
