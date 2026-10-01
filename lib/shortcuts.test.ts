import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  SHORTCUT_SCOPES,
  SHORTCUT_CONTEXT_LABELS,
  describeShortcut,
  formatShortcutKeys,
  formatShortcutKeysCompact,
  getShortcut,
  listShortcutLines,
  renderShortcutKeysHtml,
  shortcutKeys,
  shortcutsForScope,
} from "./shortcuts";

describe("shortcut registry", () => {
  it("gives every shortcut a unique id", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every context in sync with its scope label", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.context).toBe(SHORTCUT_CONTEXT_LABELS[shortcut.scope]);
    }
  });

  it("gives every shortcut keys, a description and a context", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.description.length).toBeGreaterThan(0);
      expect(shortcut.context.length).toBeGreaterThan(0);
    }
  });

  it("groups the registry by scope without losing or duplicating an entry", () => {
    expect(SHORTCUT_GROUPS.map((group) => group.scope)).toEqual(SHORTCUT_SCOPES);
    const grouped = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);
    expect(grouped).toHaveLength(SHORTCUTS.length);
    expect(grouped.map((shortcut) => shortcut.id)).toEqual(
      SHORTCUTS.map((shortcut) => shortcut.id),
    );
    for (const group of SHORTCUT_GROUPS) {
      expect(group.label).toBe(SHORTCUT_CONTEXT_LABELS[group.scope]);
      for (const shortcut of group.shortcuts) {
        expect(shortcut.scope).toBe(group.scope);
      }
    }
  });

  it("does not use the same key combination twice within a scope", () => {
    for (const scope of SHORTCUT_SCOPES) {
      const combos = shortcutsForScope(scope).map((shortcut) =>
        formatShortcutKeysCompact(shortcut.keys),
      );
      expect(new Set(combos).size).toBe(combos.length);
    }
  });

  it("throws for an unknown id instead of returning undefined", () => {
    expect(() => getShortcut("global.does-not-exist")).toThrow(
      /Unknown keyboard shortcut id/,
    );
  });

  it("exposes the create-stream-form shortcuts with their context label", () => {
    const ids = shortcutsForScope("create-stream-form").map((shortcut) => shortcut.id);
    expect(ids).toContain("create-stream-form.submit");
    expect(ids).toContain("create-stream-form.focus-recipient");
    expect(ids).toContain("create-stream-form.focus-amount");

    const recipient = getShortcut("create-stream-form.focus-recipient");
    const amount = getShortcut("create-stream-form.focus-amount");
    expect(recipient.context).toBe("Create stream form");
    expect(amount.context).toBe("Create stream form");
    expect(formatShortcutKeys(recipient.keys)).toBe("Alt + R");
    expect(formatShortcutKeys(amount.keys)).toBe("Alt + A");
    expect(formatShortcutKeysCompact(recipient.keys)).toBe("Alt+R");
  });

  it("returns a copy of the keys so call sites cannot mutate the registry", () => {
    const keys = shortcutKeys("create-stream-form.focus-recipient");
    keys.push("!");
    expect(getShortcut("create-stream-form.focus-recipient").keys).toEqual(["Alt", "R"]);
  });

  it("describes a shortcut with keys, description and context", () => {
    expect(describeShortcut(getShortcut("global.command-palette"))).toBe(
      "⌘/Ctrl + K — Open command palette (Global)",
    );
    expect(listShortcutLines()).toHaveLength(SHORTCUTS.length);
    for (const shortcut of SHORTCUTS) {
      expect(listShortcutLines()).toContain(describeShortcut(shortcut));
    }
  });

  it("renders kbd markup for surfaces that need an HTML string", () => {
    expect(renderShortcutKeysHtml(["Alt", "R"])).toBe(
      "<kbd>Alt</kbd>&thinsp;+&thinsp;<kbd>R</kbd>",
    );
  });
});
