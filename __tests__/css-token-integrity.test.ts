import fs from "node:fs";
import path from "node:path";
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { QuickDeposit } from "../app/dashboard/QuickDeposit";

interface ScanSource {
  file: string;
  source: string;
}

interface TokenUsage {
  file: string;
  line: number;
  token: string;
}

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "src"];
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const DEFINITION_PATTERN = /(--[A-Za-z0-9_-]+)\s*:/g;
const USAGE_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g;

const DYNAMIC_TOKENS = [
  "--cascade-index",
  "--progress-fill",
  "--identicon-",
  "--stream-status-",
];

const THEME_SHARED = new Set([
  "--text",
  "--card-bg",
  "--surface-raised",
  "--error",
  "--radius-lg",
  "--touch-target",
  "--badge-draft-bg",
  "--badge-draft-border",
  "--badge-draft-text",
  "--badge-active-bg",
  "--badge-active-border",
  "--badge-active-text",
  "--badge-paused-bg",
  "--badge-paused-border",
  "--badge-paused-text",
  "--badge-ended-bg",
  "--badge-ended-border",
  "--badge-ended-text",
  "--badge-cancelled-bg",
  "--badge-cancelled-border",
  "--badge-cancelled-text",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-3-5",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--radius-sm",
  "--radius-md",
  "--radius-full",
  "--radius-xl",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-4xl",
  "--font-medium",
  "--font-semibold",
  "--font-bold",
]);

function listSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

function loadSources(): ScanSource[] {
  return SCAN_DIRS.flatMap((dir) =>
    listSourceFiles(path.join(ROOT, dir)).map((absolute) => ({
      file: path.relative(ROOT, absolute),
      source: fs.readFileSync(absolute, "utf8"),
    }))
  );
}

function collectDefinitions(sources: ScanSource[]): Set<string> {
  const definitions = new Set<string>();
  for (const { source } of sources) {
    for (const match of source.matchAll(DEFINITION_PATTERN)) {
      definitions.add(match[1]);
    }
  }
  return definitions;
}

function collectUsages(sources: ScanSource[]): TokenUsage[] {
  const usages: TokenUsage[] = [];
  for (const { file, source } of sources) {
    for (const match of source.matchAll(USAGE_PATTERN)) {
      if (match[2] === ",") continue;
      usages.push({
        file,
        line: source.slice(0, match.index).split(/\r?\n/).length,
        token: match[1],
      });
    }
  }
  return usages;
}

function isDynamicToken(token: string): boolean {
  return DYNAMIC_TOKENS.some((entry) =>
    entry.endsWith("-") ? token.startsWith(entry) : token === entry
  );
}

function findUndefinedUsages(sources: ScanSource[]): TokenUsage[] {
  const definitions = collectDefinitions(sources);
  return collectUsages(sources).filter(
    ({ token }) => !definitions.has(token) && !isDynamicToken(token)
  );
}

function formatUsages(usages: TokenUsage[]): string {
  return usages.map(({ file, line, token }) => `${file}:${line} -> ${token}`).join("\n");
}

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`);
  const start = pattern.exec(css);
  if (!start) return "";

  const bodyStart = start.index + start[0].length;
  let depth = 1;
  let index = bodyStart;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  return css.slice(bodyStart, index - 1);
}

function tokensInBlock(css: string, selector: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of extractBlock(css, selector).matchAll(DEFINITION_PATTERN)) {
    tokens.add(match[1]);
  }
  return tokens;
}

function findThemeGaps(css: string, shared: Set<string>): string[] {
  const root = tokensInBlock(css, ":root");
  const light = tokensInBlock(css, ".light");
  return [...root].filter((token) => !light.has(token) && !shared.has(token)).sort();
}

describe("CSS token integrity", () => {
  const sources = loadSources();

  it("has no undefined CSS custom property references", () => {
    const undefinedUsages = findUndefinedUsages(sources);
    expect(formatUsages(undefinedUsages)).toBe("");
  });

  it("does not flag usages that provide a fallback", () => {
    const fixture: ScanSource[] = [
      {
        file: "fixture.css",
        source: [
          ":root { --known: #fff; }",
          ".a { color: var(--known); }",
          ".b { color: var(--missing, red); }",
          ".c { width: var(--progress-fill); }",
          ".d { background: var(--identicon-2-bg); }",
        ].join("\n"),
      },
    ];

    expect(findUndefinedUsages(fixture)).toEqual([]);
  });

  it("flags a fallback-less usage that is not defined", () => {
    const fixture: ScanSource[] = [
      {
        file: "fixture.css",
        source: [":root { --known: #fff; }", ".a {", "  color: var(--missing);", "}"].join(
          "\n"
        ),
      },
    ];

    expect(findUndefinedUsages(fixture)).toEqual([
      { file: "fixture.css", line: 3, token: "--missing" },
    ]);
  });

  it("flags a root token missing from .light and THEME_SHARED", () => {
    const css = [
      ":root { --themed: #fff; --shared: #000; --gap: #111; }",
      ".light { --themed: #eee; --shared: #111; }",
      ".high-contrast { --themed: #fff; }",
    ].join("\n");

    expect(findThemeGaps(css, new Set(["--shared"]))).toEqual(["--gap"]);
  });

  it("defines every :root token in .light or THEME_SHARED", () => {
    const globalsCss = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    expect(findThemeGaps(globalsCss, THEME_SHARED)).toEqual([]);
  });

  it("renders QuickDeposit with defined token references", () => {
    const { container } = render(
      React.createElement(QuickDeposit, { onDeposit: jest.fn() })
    );
    const input = screen.getByLabelText(/amount \(xlm\)/i);
    expect(input).toHaveClass("quick-deposit__input");
    expect(container.querySelector("form.quick-deposit")).not.toBeNull();

    const renderedStyles = Array.from(document.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    const source = fs.readFileSync(
      path.join(ROOT, "app/dashboard/QuickDeposit.tsx"),
      "utf8"
    );
    const css = renderedStyles.includes("quick-deposit__input")
      ? renderedStyles
      : source;

    expect(css).toContain("background: var(--background)");
    expect(css).toContain("border: 1px solid var(--border)");
    expect(css).not.toMatch(/var\(--bg(?![A-Za-z0-9_-])/);
  });
});
