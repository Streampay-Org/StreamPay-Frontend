import React from "react";

export interface KbdShortcut {
  keys: string[];
  description: string;
}

export interface KbdHintProps {
  /** One or more key labels, e.g. ["Ctrl", "K"] */
  keys?: string[];
  /** Human-readable description of what the shortcut does */
  label?: string;
  /** List of shortcuts for multi-shortcut display */
  shortcuts?: KbdShortcut[];
  /** Hide from assistive tech when the hint is purely decorative */
  "aria-hidden"?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function KbdHint({
  keys,
  label,
  shortcuts,
  "aria-hidden": ariaHidden,
  className,
  "data-testid": testId = "kbd-hint",
}: KbdHintProps) {
  if (shortcuts && shortcuts.length > 0) {
    return (
      <div
        className={["kbd-hints", className].filter(Boolean).join(" ")}
        data-testid={testId}
        aria-hidden={ariaHidden}
      >
        {shortcuts.map((sc, index) => (
          <div key={index} className="kbd-hint__item">
            <span className="kbd-hint__keys">
              {sc.keys.map((key, i) => (
                <React.Fragment key={key}>
                  {i > 0 && <span className="kbd-hint__separator">+</span>}
                  <kbd className="kbd">{key}</kbd>
                </React.Fragment>
              ))}
            </span>
            <span className="kbd-hint__description">{sc.description}</span>
          </div>
        ))}
      </div>
    );
  }

  const keyList = keys ?? [];
  const wrapperProps = ariaHidden
    ? { "aria-hidden": "true" as const }
    : { "aria-label": `Keyboard shortcut: ${keyList.join(" ")}`, title: label };

  return (
    <span
      className={["kbd-hint__item", className].filter(Boolean).join(" ")}
      data-testid={testId}
      {...wrapperProps}
    >
      <span className="kbd-hint__keys">
        {keyList.map((key, i) => (
          <React.Fragment key={key}>
            {i > 0 && <span className="kbd-hint__separator">+</span>}
            <kbd className="kbd">{key}</kbd>
          </React.Fragment>
        ))}
      </span>
      {label && <span className="kbd-hint__description">{label}</span>}
    </span>
  );
}

export default KbdHint;
