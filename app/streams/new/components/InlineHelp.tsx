"use client";

import {
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export interface InlineHelpProps {
  title: string;
  children: ReactNode;
  triggerLabel?: string;
  className?: string;
}

export function InlineHelp({
  title,
  children,
  triggerLabel = "Show help",
  className = "",
}: InlineHelpProps) {
  const [open, setOpen] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const pointerDownOnOverlayRef = useRef(false);

  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      previouslyFocusedRef.current = document.activeElement as HTMLElement;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => dialogRef.current?.focus());
      return;
    }
    previouslyFocusedRef.current?.focus();
    previouslyFocusedRef.current = null;
  }, [open]);

  const handleClose = () => {
    setOpen(false);
  };

  const handleAnimationEnd = () => {
    if (!open) setShouldRender(false);
  };

  const handleOverlayPointerDown = (event: MouseEvent<HTMLDivElement>) => {
    pointerDownOnOverlayRef.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    const startedOnOverlay = pointerDownOnOverlayRef.current;
    pointerDownOnOverlayRef.current = false;
    if (startedOnOverlay && event.target === event.currentTarget) {
      handleClose();
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
        ].join(","),
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true",
    );
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`inline-help__trigger ${className}`.trim()}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerLabel}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">?</span>
      </button>

      {shouldRender && (
        <div
          data-inline-help-overlay="true"
          onMouseDown={handleOverlayPointerDown}
          onClick={handleOverlayClick}
          onAnimationEnd={handleAnimationEnd}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            backdropFilter: "blur(2px)",
            zIndex: 1000,
            animation: `${open ? "fadeIn" : "fadeOut"} var(--motion-duration-medium, 200ms) ease forwards`,
          }}
        >
          <div
            ref={dialogRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleDialogKeyDown}
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "100%",
              maxWidth: "min(420px, 100vw)",
              backgroundColor: "var(--panel-elevated)",
              borderLeft: "1px solid var(--border)",
              boxShadow: "var(--shadow-soft)",
              display: "flex",
              flexDirection: "column",
              animation: `${open ? "slideInRight" : "slideOutRight"} var(--motion-duration-medium, 250ms) ease forwards`,
            }}
          >
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "1rem 1.25rem",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <h2
                id={titleId}
                style={{ fontSize: "1.125rem", fontWeight: 600 }}
              >
                {title}
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close help panel"
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
                padding: "1.25rem",
                flex: 1,
                overflowY: "auto",
                fontSize: "0.875rem",
                lineHeight: 1.6,
                color: "var(--muted-light)",
              }}
            >
              {children}
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes slideOutRight {
          from { transform: translateX(0); }
          to { transform: translateX(100%); }
        }
      `}</style>
    </>
  );
}
