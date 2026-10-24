import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_GLOBALS_CSS_LINES = 5_095;

describe("global stylesheet size budget", () => {
  it("keeps route-specific styles out of the shared stylesheet", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const lineCount = css.split(/\r?\n/).length;

    expect(lineCount).toBeLessThanOrEqual(MAX_GLOBALS_CSS_LINES);
  });
});
