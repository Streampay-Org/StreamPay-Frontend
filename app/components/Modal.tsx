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
  /**
   * Optional className for the dialog container.
   */
  className?: string;
  /**
   * Optional aria-labelledby override. Defaults to the internal title id.
   */
  ariaLabelledBy?: string;
  /**
   * Optional aria-describedby id.
   */
  ariaDescribedBy?: string;
  /**
   * Whether to render the default header with title and close button.
   * @default true
   */
  showHeader?: boolean;
  /**
   * Optional custom onClose for the header close button label.
   * @default "Close modal"
   */
  closeLabel?: string;
}

export interface FocusTrapResult {
  dialogRef: RefObject<HTMLElement | null>;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  getFocusableElements: () => HTMLElement[];
}

export interface UseFocusTrapOptions {
  restoreFocusTarget?: FocusTarget;
  autoRestoreFocus?: boolean;
}

/**
 * Hook that implements a focus trap for a dialog container.
 * Captures the previously focused element on open and restores focus on close.
 */
export function useFocusTrap(
  isOpen: boolean,
  onClose: () => void,
  options?: UseFocusTrapOptions,
): FocusTrapResult {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const restoreFocusTarget = options?.restoreFocusTarget;
  const autoRestoreFocus = options?.autoRestoreFocus ?? false;

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
    if (isOpen) {
      if (!previouslyFocusedElementRef.current) {
        previouslyFocusedElementRef.current =
          document.activeElement as HTMLElement | null;
      }
      dialogRef.current?.focus();
    } else if (previouslyFocusedElementRef.current) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoRestoreFocus, restoreFocusTarget]);

  const getFocusableElements = (): HTMLElement[] => {
    if (!dialogRef.current) return [];

    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        [
          "a[href]",
          "button:not([disabled])",
          "textarea:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "[data-focus-trap-initial]",
          "[tabindex]:not([tabindex='-1'])",
        ].join(","),
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true",
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
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

  return { dialogRef, handleKeyDown, getFocusableElements };
}

export const Modal: React.FC<PropsWithChildren<ModalProps>> = ({
  isOpen,
  onClose,
  title,
  restoreFocusTarget,
  autoRestoreFocus = true,
  className,
  ariaLabelledBy,
  ariaDescribedBy,
  showHeader = true,
  closeLabel = "Close modal",
  children,
}) => {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const pointerDownOnOverlayRef = useRef(false);
  const titleId = useId();
  const { dialogRef, handleKeyDown } = useFocusTrap(isOpen, onClose, {
    restoreFocusTarget,
    autoRestoreFocus,
  });

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

  const handleAnimationEnd = () => {
    if (!isOpen) setShouldRender(false);
  };

  const handleOverlayPointerDown = (event: MouseEvent<HTMLElement>) => {
    pointerDownOnOverlayRef.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event: MouseEvent<HTMLElement>) => {
    const startedOnOverlay = pointerDownOnOverlayRef.current;
    pointerDownOnOverlayRef.current = false;
    if (startedOnOverlay && event.target === event.currentTarget) {
      onClose();
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
        aria-labelledby={ariaLabelledBy ?? ariaLabelledBy ?? titleId}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        className={className}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          maxWidth: "500px",
          backgroundColor: "var(--panel-elevated)",
          border: "1px solid var(--border)",
          borderRadius: "1rem",
          padding: "1.5rem",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          animation: `${isOpen ? "scaleIn" : "scaleOut"} var(--motion-duration-medium) var(--motion-easing) forwards`,
        }}
      >
        {showHeader && (
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
              aria-label={closeLabel}
              style={{
                background: "none",
                border: "none",
                color: "var(--muted)",
                cursor: "pointer",
                fontSize: "1.5rem",
              }}
            >
              í
            </button>
          </header>
        )}
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
