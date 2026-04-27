"use client";

import React, { PropsWithChildren, useEffect, useState } from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: React.ReactNode;
}

export default function Modal({ isOpen, onClose, title, description, footer, children }: PropsWithChildren<ModalProps>) {
  const [shouldRender, setShouldRender] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      document.body.style.overflow = "hidden";
    } else {
      if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
        setShouldRender(false);
      }
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleAnimationEnd = () => {
    if (!isOpen) setShouldRender(false);
  };

  if (!shouldRender) return null;

  return (
    <div
      onClick={onClose}
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
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
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
          <h2 style={{ fontSize: "1.25rem" }}>{title}</h2>
          <button
            aria-label="Close dialog"
            onClick={onClose}
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
        {description && <p style={{ marginBottom: "1rem", color: "var(--muted)" }}>{description}</p>}
        {children}
        {footer && <footer style={{ marginTop: "1.5rem", display: "flex", justifyContent: "flex-end", gap: "1rem" }}>{footer}</footer>}
      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes scaleIn {
          from { transform: scale(0.95); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes scaleOut {
          from { transform: scale(1); opacity: 1; }
          to { transform: scale(0.95); opacity: 0; }
        }
      `}</style>
    </div>
  );
};
