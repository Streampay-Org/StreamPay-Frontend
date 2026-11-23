/**
 * @jest-environment jsdom
 */

import fs from "fs";
import path from "path";

// Jest maps CSS imports to an empty mock module (next/jest's styleMock), so
// `import "./focus.css"` never actually populates `document.styleSheets` in
// this environment. Read the source file directly instead — it's the only
// way to assert on the real rule text.
const styleText = fs.readFileSync(path.join(__dirname, "focus.css"), "utf8");

describe("shared focus-visible layer", () => {
  it("declares a keyboard-visible focus ring for interactive elements", () => {
    expect(styleText).toContain(":focus-visible");
    expect(styleText).toContain("outline: 2px solid var(--accent);");
    expect(styleText).toContain("box-shadow: 0 0 0 2px var(--background);");
  });

  it("includes the StreamProgress track so keyboard focus gets a visible outline", () => {
    expect(styleText).toContain(".stream-progress__track");
  });

  it("includes the StreamRow action button in the keyboard-visible focus layer", () => {
    expect(styleText).toContain(".stream-row__action");
  });

  it("includes the StreamTypeChip in the keyboard-visible focus layer", () => {
    expect(styleText).toContain(".stream-type-chip");
  });

  it("hides the outline again for mouse/touch focus on the StreamProgress track", () => {
    const suppressionRule = styleText.split(":focus-visible {")[1] ?? "";
    expect(suppressionRule).toContain(".stream-progress__track");
    expect(suppressionRule).toContain(".stream-row__action");
    expect(suppressionRule).toContain(".stream-type-chip");
    expect(styleText).toContain(":focus:not(:focus-visible)");
  });

  it("includes .csf-field in the focus-visible selector list", () => {
    expect(styleText).toContain(".csf-field");
  });

  it("declares a CreateStreamForm-specific focus-visible rule", () => {
    expect(styleText).toContain(".create-stream-form .csf-field:focus-visible");
    expect(styleText).toContain("border-color: var(--accent)");
  });

  it("suppresses focus outline for mouse/touch on .csf-field", () => {
    expect(styleText).toContain(
      ".create-stream-form .csf-field:focus:not(:focus-visible)"
    );
  });
});
