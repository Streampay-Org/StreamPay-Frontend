"use client";

import { useEffect, useState } from "react";

/** Announces a pending load; shows a lightweight dialog only if it takes > 300ms. */
export function LazyDialogShell({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div role="status" aria-live="polite">
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {label}
      </span>
      {visible && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          style={{
            position: "fixed",
            top: "20vh",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "1rem 1.5rem",
            background: "var(--surface, #fff)",
            color: "var(--foreground, #000)",
            border: "1px solid var(--border, #ccc)",
            borderRadius: 8,
            zIndex: 1000,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
