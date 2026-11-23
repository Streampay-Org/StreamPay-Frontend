/**
 * @jest-environment jsdom
 */

import fs from "fs";
import path from "path";

const styleText = fs.readFileSync(path.join(__dirname, "patterns.css"), "utf8");

describe("shared color-blind pattern layer", () => {
  it("defines texture hooks for the StreamProgress fill", () => {
    expect(styleText).toContain(".stream-progress__fill.cb-pattern");
    expect(styleText).toContain(".stream-progress__fill.cb-pattern--active");
    expect(styleText).toContain(".stream-progress__fill.cb-pattern--paused");
    expect(styleText).toContain(".stream-progress__fill.cb-pattern--ended");
    expect(styleText).toContain(".stream-progress__fill.cb-pattern--cancelled");
    expect(styleText).toContain(".stream-progress__fill.cb-pattern--draft");
  });

  it("keeps the pattern textures layered under the fill color", () => {
    expect(styleText.replace(/\r\n/g, "\n")).toContain("background-image:\n      var(--cb-pattern-active),");
    expect(styleText).toContain("background-blend-mode: multiply;");
  });

  it("includes WalletBadge dot pattern rules with optimised tile size", () => {
    expect(styleText).toContain(".wallet-badge__dot.cb-pattern::before");
    expect(styleText).toContain("background-size: 8px 8px");
    expect(styleText).toContain("border-radius: 50%");
  });
});