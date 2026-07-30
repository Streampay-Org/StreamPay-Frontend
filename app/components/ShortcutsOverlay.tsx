"use client";

import React, {
  KeyboardEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

interface ShortcutGroup {
  label: string;
  shortcuts: { keys: string[]; description: string }[];
}

const GROUPS: ShortcutGroup[] = [
  {
    label: "Global",
    shortcuts: [
      { keys: ["?"], description: "Show keyboard shortcuts" },
      { keys: ["⌘/Ctrl", "K"], description: "Open command palette" },
      { keys: ["Esc"], description: "Close dialogs" },
    ],
  },
  {
    label: "Navigation",
    shortcuts: [
      { keys: ["Tab"], description: "Move focus forward" },
      { keys: ["Shift", "Tab"], description: "Move focus backward" },
      { keys: ["↑", "↓"], description: "Navigate lists" },
      { keys: ["←", "→"], description: "Navigate tabs" },
      { keys: ["Home"], description: "First tab" },
      { keys: ["End"], description: "Last tab" },
      { keys: ["Enter"], description: "Select or activate" },
    ],
  },
];

export function ShortcutsOverlay() {
  const [isOpen, setIsOpen] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const pointerDownOnOverlayRef = useRef(false);
  const titleId = useId();

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (isOpen) setShouldRender(true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      previouslyFocusedElementRef.current =
        document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => dialogRef.current?.focus());
      return;
    }

    previouslyFocusedElementRef.current?.focus();
    previouslyFocusedElementRef.current = null;
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "?") {
        event.preventDefault();
        if (isOpen) {
          close();
        } else {
          open();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, open, close]);

  const handleAnimationEnd = () => {
    if (!isOpen) setShouldRender(false);
  };

  const handleOverlayPointerDown = (event: MouseEvent<HTMLDivElement>) => {
    pointerDownOnOverlayRef.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    const startedOnOverlay = pointerDownOnOverlayRef.current;
    pointerDownOnOverlayRef.current = false;
    if (startedOnOverlay && event.target === event.currentTarget) {
      close();
    }
  };

  const getFocusableElements = () => {
    if (!dialogRef.current) return [];
    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        [
          "a[href]",
          "button:not([disabled])",
          "textarea:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "[tabindex]:not([tabindex='-1'])",
        ].join(",")
      )
    ).filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true"
    );
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = getFocusableElements();

    if (focusableElements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const firstFocusableElement = focusableElements[0];
    const lastFocusableElement =
      focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey) {
      if (
        activeElement === firstFocusableElement ||
        !dialogRef.current?.contains(activeElement)
      ) {
        event.preventDefault();
        lastFocusableElement.focus();
      }
      return;
    }

    if (
      activeElement === lastFocusableElement ||
      !dialogRef.current?.contains(activeElement)
    ) {
      event.preventDefault();
      firstFocusableElement.focus();
    }
  };

  if (!shouldRender) return null;

  return (
    <div
      data-shortcuts-overlay="true"
      onMouseDown={handleOverlayPointerDown}
      onClick={handleOverlayClick}
      onAnimationEnd={handleAnimationEnd}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000,
        animation: `${isOpen ? "shortcutsFadeIn" : "shortcutsFadeOut"} var(--motion-duration-medium, 200ms) var(--motion-easing, ease) forwards`,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        style={{
          width: "100%",
          maxWidth: "520px",
          maxHeight: "80vh",
          backgroundColor: "var(--card-surface)",
          border: "1px solid var(--card-border)",
          borderRadius: "1rem",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          animation: `${isOpen ? "shortcutsScaleIn" : "shortcutsScaleOut"} var(--motion-duration-medium, 200ms) var(--motion-easing, ease) forwards`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "1.25rem 1.5rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2
            id={titleId}
            style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}
          >
            Keyboard Shortcuts
          </h2>
          <button
            onClick={close}
            aria-label="Close shortcuts overlay"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: "1.5rem",
              lineHeight: 1,
              padding: "0.25rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "44px",
              minHeight: "44px",
            }}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </header>

        <div
          style={{
            padding: "1rem 1.5rem 1.5rem",
            overflowY: "auto",
            flex: 1,
          }}
        >
          {GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: "1.25rem" }}>
              <h3
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--muted)",
                  margin: "0 0 0.5rem",
                }}
              >
                {group.label}
              </h3>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.375rem",
                }}
              >
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.375rem 0",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.875rem",
                        color: "var(--foreground)",
                      }}
                    >
                      {shortcut.description}
                    </span>
                    <span style={{ display: "flex", gap: "0.25rem" }}>
                      {shortcut.keys.map((key, i) => (
                        <React.Fragment key={key}>
                          {i > 0 && (
                            <span
                              style={{
                                color: "var(--muted)",
                                fontSize: "0.75rem",
                                display: "flex",
                                alignItems: "center",
                              }}
                            >
                              +
                            </span>
                          )}
                          <kbd
                            style={{
                              display: "inline-block",
                              padding: "0.125rem 0.375rem",
                              fontSize: "0.6875rem",
                              fontWeight: 700,
                              lineHeight: 1,
                              color: "var(--muted-light)",
                              backgroundColor: "var(--panel)",
                              border: "1px solid var(--border)",
                              borderRadius: "0.25rem",
                              minWidth: "1.25rem",
                              textAlign: "center",
                              fontFamily: "inherit",
                            }}
                          >
                            {key}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <footer
          style={{
            padding: "0.75rem 1.5rem",
            borderTop: "1px solid var(--border)",
            fontSize: "0.75rem",
            color: "var(--muted)",
            textAlign: "center",
          }}
        >
          Press <kbd style={inlineKbdStyle}>?</kbd> to toggle this overlay
        </footer>
      </div>

      <style jsx global>{`
        @keyframes shortcutsFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes shortcutsFadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes shortcutsScaleIn {
          from { transform: scale(0.95); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes shortcutsScaleOut {
          from { transform: scale(1); opacity: 1; }
          to { transform: scale(0.95); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

const inlineKbdStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.125rem 0.375rem",
  fontSize: "0.6875rem",
  fontWeight: 700,
  lineHeight: 1,
  color: "var(--muted-light)",
  backgroundColor: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "0.25rem",
  minWidth: "1.25rem",
  textAlign: "center",
  fontFamily: "inherit",
};
