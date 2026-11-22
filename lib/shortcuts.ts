/**
 * Single source of truth for every keyboard shortcut in StreamPay.
 *
 * Consumers (all read from here, none keep a local copy):
 *   - `app/components/ShortcutsOverlay.tsx` — the `?` overlay
 *   - `app/help/page.tsx`                  — the Keyboard Shortcuts FAQ answers
 *   - `app/CreateStreamForm.tsx`           — KbdHint labels on the form controls
 *   - `docs/receiptcard-kbd-hints.md`      — the written reference
 *
 * Before this module the overlay, the form JSDoc and the Help FAQ each carried
 * their own hand-maintained list and had drifted apart (the Alt shortcuts were
 * missing from the overlay). Add or change a shortcut here and every surface
 * follows.
 */

export type ShortcutScope =
  | "global"
  | "navigation"
  | "create-stream-form"
  | "receipt-card";

export interface ShortcutDefinition {
  /** Stable identifier, used by call sites that render a single hint. */
  id: string;
  scope: ShortcutScope;
  /** Key tokens, rendered left to right and joined with "+". */
  keys: string[];
  /** What the shortcut does. */
  description: string;
  /** Where the shortcut is live — always `SHORTCUT_CONTEXT_LABELS[scope]`. */
  context: string;
  /** Other spellings that trigger the same shortcut (macOS Cmd, "Ctrl+Enter", …). */
  aliases?: string[];
}

export interface ShortcutGroup {
  scope: ShortcutScope;
  label: string;
  shortcuts: ShortcutDefinition[];
}

/** Human-readable label for each scope; also the group heading in the overlay. */
export const SHORTCUT_CONTEXT_LABELS: Record<ShortcutScope, string> = {
  global: "Global",
  navigation: "Navigation",
  "create-stream-form": "Create stream form",
  "receipt-card": "Receipt card",
};

/** Display order of the groups in the overlay and in the Help reference. */
export const SHORTCUT_SCOPES: ShortcutScope[] = [
  "global",
  "navigation",
  "create-stream-form",
  "receipt-card",
];

const label = (scope: ShortcutScope): string => SHORTCUT_CONTEXT_LABELS[scope];

/**
 * The registry. `context` is derived from `scope` through the helper below so
 * the two can never disagree.
 */
export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "global.toggle-overlay",
    scope: "global",
    keys: ["?"],
    description: "Show keyboard shortcuts",
    context: label("global"),
    aliases: ["Shift+/"],
  },
  {
    id: "global.command-palette",
    scope: "global",
    keys: ["⌘/Ctrl", "K"],
    description: "Open command palette",
    context: label("global"),
    aliases: ["Ctrl+K", "Cmd+K", "Meta+K"],
  },
  {
    id: "global.close-dialogs",
    scope: "global",
    keys: ["Esc"],
    description: "Close dialogs",
    context: label("global"),
    aliases: ["Escape"],
  },
  {
    id: "navigation.focus-forward",
    scope: "navigation",
    keys: ["Tab"],
    description: "Move focus forward",
    context: label("navigation"),
  },
  {
    id: "navigation.focus-backward",
    scope: "navigation",
    keys: ["Shift", "Tab"],
    description: "Move focus backward",
    context: label("navigation"),
  },
  {
    id: "navigation.lists",
    scope: "navigation",
    keys: ["↑", "↓"],
    description: "Navigate lists",
    context: label("navigation"),
  },
  {
    id: "navigation.tabs",
    scope: "navigation",
    keys: ["←", "→"],
    description: "Navigate tabs",
    context: label("navigation"),
  },
  {
    id: "navigation.first-tab",
    scope: "navigation",
    keys: ["Home"],
    description: "First tab",
    context: label("navigation"),
  },
  {
    id: "navigation.last-tab",
    scope: "navigation",
    keys: ["End"],
    description: "Last tab",
    context: label("navigation"),
  },
  {
    id: "navigation.activate",
    scope: "navigation",
    keys: ["Enter"],
    description: "Select or activate",
    context: label("navigation"),
  },
  {
    id: "create-stream-form.submit",
    scope: "create-stream-form",
    keys: ["Ctrl", "↵"],
    description: "Submit the form",
    context: label("create-stream-form"),
    aliases: ["Ctrl+Enter", "Cmd+Enter", "Meta+Enter"],
  },
  {
    id: "create-stream-form.cancel",
    scope: "create-stream-form",
    keys: ["Esc"],
    description: "Cancel and close the form",
    context: label("create-stream-form"),
    aliases: ["Escape"],
  },
  {
    id: "create-stream-form.focus-recipient",
    scope: "create-stream-form",
    keys: ["Alt", "R"],
    description: "Jump focus to the recipient field",
    context: label("create-stream-form"),
    aliases: ["Alt+R"],
  },
  {
    id: "create-stream-form.focus-amount",
    scope: "create-stream-form",
    keys: ["Alt", "A"],
    description: "Jump focus to the amount field",
    context: label("create-stream-form"),
    aliases: ["Alt+A"],
  },
  {
    id: "receipt-card.toggle-mask",
    scope: "receipt-card",
    keys: ["M"],
    description: "Toggle recipient address masking",
    context: label("receipt-card"),
  },
  {
    id: "receipt-card.copy",
    scope: "receipt-card",
    keys: ["C"],
    description: "Copy the formatted receipt text",
    context: label("receipt-card"),
  },
];

/** The registry, grouped by scope in display order. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = SHORTCUT_SCOPES.map((scope) => ({
  scope,
  label: SHORTCUT_CONTEXT_LABELS[scope],
  shortcuts: SHORTCUTS.filter((shortcut) => shortcut.scope === scope),
}));

/** Every shortcut that applies in the given scope, in registry order. */
export function shortcutsForScope(scope: ShortcutScope): ShortcutDefinition[] {
  return SHORTCUTS.filter((shortcut) => shortcut.scope === scope);
}

/**
 * Look up a shortcut by id. Throws instead of returning `undefined` so a typo
 * in a call site fails loudly rather than rendering an empty hint.
 */
export function getShortcut(id: string): ShortcutDefinition {
  const found = SHORTCUTS.find((shortcut) => shortcut.id === id);
  if (!found) {
    throw new Error(`Unknown keyboard shortcut id: ${id}`);
  }
  return found;
}

/** Fresh copy of a shortcut's key tokens, ready for `<KbdHint keys={…} />`. */
export function shortcutKeys(id: string): string[] {
  return [...getShortcut(id).keys];
}

/** "Alt + R" */
export function formatShortcutKeys(keys: string[], separator = " + "): string {
  return keys.join(separator);
}

/** "Alt+R" — the spelling used by `aria-keyshortcuts` and the docs. */
export function formatShortcutKeysCompact(keys: string[]): string {
  return keys.join("+");
}

/** "Alt + R — Jump focus to the recipient field (Create stream form)" */
export function describeShortcut(shortcut: ShortcutDefinition): string {
  return `${formatShortcutKeys(shortcut.keys)} — ${shortcut.description} (${shortcut.context})`;
}

/** Markup helper for surfaces that render trusted, static HTML strings. */
export function renderShortcutKeysHtml(keys: string[]): string {
  return keys.map((key) => `<kbd>${key}</kbd>`).join("&thinsp;+&thinsp;");
}

/** One plain-text line per shortcut, used to keep the docs and tests honest. */
export function listShortcutLines(): string[] {
  return SHORTCUTS.map((shortcut) => describeShortcut(shortcut));
}
