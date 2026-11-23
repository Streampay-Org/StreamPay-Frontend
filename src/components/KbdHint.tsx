import React from "react";

export interface KbdShortcut {
  keys: string[];
  description: string;
}

export interface KbdHintProps {
  /** One or more key labels, e.g. ["Ctrl", "K"] (a single string is also accepted). */
  keys?: string | string[];
  /** Shortcut written as a string, e.g. "Ctrl+K". Alternative to `keys`. */
  shortcut?: string;
  /** A list of shortcuts rendered as a legend. */
  shortcuts?: KbdShortcut[];
  /** Human-readable description of what the shortcut does */
  label?: string;
  /** Explicit aria-label override */
  ariaLabel?: string;
  /** Hide from assistive tech when the hint is purely decorative */
  "aria-hidden"?: boolean;
  className?: string;
  variant?: string;
  size?: string;
  testId?: string;
  "data-testid"?: string;
}

function normalizeKeys(keys?: string | string[], shortcut?: string): string[] {
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "string") return keys.split("+").map((k) => k.trim()).filter(Boolean);
  if (shortcut) return shortcut.split("+").map((k) => k.trim()).filter(Boolean);
  return [];
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="kbd-hint__keys">
      {keys.map((key, i) => (
        <React.Fragment key={`${key}-${i}`}>
          {i > 0 && <span className="kbd-hint__separator">+</span>}
          <kbd className="kbd">{key}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

export function KbdHint({
  keys,
  shortcut,
  shortcuts,
  label,
  ariaLabel,
  "aria-hidden": ariaHidden,
  className,
  variant,
  size,
  testId,
  "data-testid": dataTestId,
}: KbdHintProps) {
  if (shortcuts) {
    return (
      <ul className={["kbd-hint__list", className].filter(Boolean).join(" ")} data-testid={dataTestId ?? testId ?? "kbd-hint-list"}>
        {shortcuts.map((s) => (
          <li key={s.keys.join("+")} className="kbd-hint__row">
            <Keys keys={s.keys} />
            <span className="kbd-hint__desc">{s.description}</span>
          </li>
        ))}
      </ul>
    );
  }

  const list = normalizeKeys(keys, shortcut);
  const wrapperProps = ariaHidden
    ? { "aria-hidden": "true" as const }
    : { "aria-label": ariaLabel ?? `Keyboard shortcut: ${list.join(" ")}`, title: label };

  return (
    <span
      className={["kbd-hint__item", variant && `kbd-hint--${variant}`, size && `kbd-hint--${size}`, className]
        .filter(Boolean)
        .join(" ")}
      data-testid={dataTestId ?? testId ?? "kbd-hint"}
      {...wrapperProps}
    >
      <Keys keys={list} />
    </span>
  );
}

export default KbdHint;
