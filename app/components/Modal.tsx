"use client";

import React, {
  KeyboardEvent,
  MouseEvent,
  PropsWithChildren,
  RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type FocusTarget =
  | HTMLElement
  | RefObject<HTMLElement | null>
  | (() => HTMLElement | null | undefined)
  | null
  | undefined;

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /**
   * Optional custom element, ref, or callback to restore focus to on modal close.
   * Defaults to the element that was active when the modal opened.
   */
  restoreFocusTarget?: FocusTarget;
  /**
   * Whether to automatically restore focus upon modal close.
   * @default true
   */
  autoRestoreFocus?: boolean;
}

export const Modal: React.FC<PropsWithChildren<ModalProps>> = ({
  isOpen,
  onClose,
  title,
  restoreFocusTarget,
  autoRestoreFocus = true,
  children,
}) => {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const pointerDownOnOverlayRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const resolveTargetElement = (): HTMLElement | null => {
    if (restoreFocusTarget !== undefined) {
      if (typeof restoreFocusTarget === "function") {
        return restoreFocusTarget() ?? null;
      }
      if (restoreFocusTarget && "current" in restoreFocusTarget) {
        return restoreFocusTarget.current;
      }
      return restoreFocusTarget ?? null;
    }
    return previouslyFocusedElementRef.current;
  };

  useEffect(() => {
    if (isOpen && shouldRender) {
      if (!previouslyFocusedElementRef.current) {
        previouslyFocusedElementRef.current =
          document.activeElement as HTMLElement | null;
      }
      dialogRef.current?.focus();
    } else if (!isOpen && previouslyFocusedElementRef.current) {
      if (autoRestoreFocus) {
        const target = resolveTargetElement();
        if (
          target &&
          typeof target.focus === "function" &&
          target.isConnected
        ) {
          target.focus();
        }
      } else {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
      previouslyFocusedElementRef.current = null;
    }
  }, [isOpen, shouldRender, autoRestoreFocus, restoreFocusTarget]);

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
      onClose();
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
      onClose();
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
      data-modal-overlay="true"
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
        animation: `${isOpen ? "fadeIn" : "fadeOut"} var(--motion-duration-medium) var(--motion-easing) forwards`,
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
          maxWidth: "500px",
          backgroundColor: "var(--card-surface)",
          border: "1px solid var(--card-border)",
          borderRadius: "1rem",
          padding: "1.5rem",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          animation: `${isOpen ? "scaleIn" : "scaleOut"} var(--motion-duration-medium) var(--motion-easing) forwards`,
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.5rem",
          }}
        >
          <h2 id={titleId} style={{ fontSize: "1.25rem" }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close modal"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: "1.5rem",
            }}
          >
            ×
          </button>
        </header>
        {children}
      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes fadeOut {
          from {
            opacity: 1;
          }
          to {
            opacity: 0;
          }
        }
        @keyframes scaleIn {
          from {
            transform: scale(0.95);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }
        @keyframes scaleOut {
          from {
            transform: scale(1);
            opacity: 1;
          }
          to {
            transform: scale(0.95);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
};
