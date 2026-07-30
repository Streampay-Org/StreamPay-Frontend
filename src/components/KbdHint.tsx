import React from "react";

export interface KbdHintProps {
  /** One or more key labels, e.g. ["Ctrl", "K"] */
  keys: string[];
  /** Human-readable description of what the shortcut does */
  label: string;
  /** Hide from assistive tech when the hint is purely decorative */
  "aria-hidden"?: boolean;
  className?: string;
}

export function KbdHint({ keys, label, "aria-hidden": ariaHidden, className }: KbdHintProps) {
  const wrapperProps = ariaHidden
    ? { "aria-hidden": "true" as const }
    : { "aria-label": `Keyboard shortcut: ${keys.join(" ")}`, title: label };

  return (
    <span
      className={["kbd-hint__item", className].filter(Boolean).join(" ")}
      data-testid="kbd-hint"
      {...wrapperProps}
    >
      <span className="kbd-hint__keys">
        {keys.map((key, i) => (
          <React.Fragment key={key}>
            {i > 0 && <span className="kbd-hint__separator">+</span>}
            <kbd className="kbd">{key}</kbd>
          </React.Fragment>
        ))}
      </span>
    </span>
  );
}

export default KbdHint;
