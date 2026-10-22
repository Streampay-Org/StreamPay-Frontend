import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface QuarantineEntry {
  path: string;
  reason?: string;
  owner?: string;
  issue?: string;
}

export interface QuarantineManifest {
  QUARANTINE_MAX: number;
  entries: QuarantineEntry[];
}

export function getManifest(rootDir: string = process.cwd()): QuarantineManifest {
  const manifestPath = path.join(rootDir, "jest.quarantine.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Quarantine manifest not found at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function getBaselineMax(rootDir: string = process.cwd(), inManifestMax?: number): number {
  try {
    const raw = execSync("git show origin/main:jest.quarantine.json", {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw);
    if (typeof parsed.QUARANTINE_MAX === "number") {
      return parsed.QUARANTINE_MAX;
    }
  } catch {
    // origin/main:jest.quarantine.json is unavailable or git is not installed/reachable
  }

  if (typeof inManifestMax === "number") {
    return inManifestMax;
  }
  return Infinity;
}

export function validateQuarantineManifest(
  manifest: QuarantineManifest,
  baselineMax: number,
  rootDir: string = process.cwd()
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifest.entries.length > manifest.QUARANTINE_MAX) {
    errors.push(
      `Manifest entries count (${manifest.entries.length}) exceeds QUARANTINE_MAX (${manifest.QUARANTINE_MAX})`
    );
  }

  if (manifest.entries.length > baselineMax) {
    errors.push(
      `Manifest entries count (${manifest.entries.length}) exceeds baseline max (${baselineMax})`
    );
  }

  if (manifest.QUARANTINE_MAX > baselineMax) {
    errors.push(
      `QUARANTINE_MAX (${manifest.QUARANTINE_MAX}) may not increase above baseline (${baselineMax})`
    );
  }

  for (const entry of manifest.entries) {
    if (!entry.reason || entry.reason.trim() === "") {
      errors.push(`Entry "${entry.path}" lacks a reason`);
    }

    const fullPath = path.resolve(rootDir, entry.path);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Entry points to missing file: "${entry.path}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

describe("Quarantine Ratchet", () => {
  const rootDir = path.resolve(__dirname, "..");
  const manifest = getManifest(rootDir);
  const baselineMax = getBaselineMax(rootDir, manifest.QUARANTINE_MAX);

  test("Scenario 1: current manifest passes ratchet validation", () => {
    const result = validateQuarantineManifest(manifest, baselineMax, rootDir);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("Scenario 2: adding an entry causes ratchet to fail naming the entry", () => {
    const fixtureManifest: QuarantineManifest = {
      QUARANTINE_MAX: manifest.QUARANTINE_MAX,
      entries: [
        ...manifest.entries,
        {
          path: "non-existent-added-test.ts",
          reason: "Added fixture test",
        },
      ],
    };

    const result = validateQuarantineManifest(fixtureManifest, baselineMax, rootDir);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((err) => err.includes("exceeds QUARANTINE_MAX") || err.includes("exceeds baseline max"))
    ).toBe(true);
    expect(
      result.errors.some((err) => err.includes("non-existent-added-test.ts"))
    ).toBe(true);
  });

  test("Scenario 3: an entry pointing at a missing file fails", () => {
    const fixtureManifest: QuarantineManifest = {
      QUARANTINE_MAX: manifest.QUARANTINE_MAX + 1,
      entries: [
        {
          path: "missing-file-suite.test.ts",
          reason: "Some reason",
        },
      ],
    };

    const result = validateQuarantineManifest(fixtureManifest, 100, rootDir);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (err) => err.includes("missing-file-suite.test.ts") && err.includes("missing file")
      )
    ).toBe(true);
  });

  test("Scenario 4: an entry without a reason fails", () => {
    const fixtureManifest: QuarantineManifest = {
      QUARANTINE_MAX: manifest.QUARANTINE_MAX + 1,
      entries: [
        {
          path: manifest.entries[0].path,
          reason: "",
        },
      ],
    };

    const result = validateQuarantineManifest(fixtureManifest, 100, rootDir);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (err) => err.includes(manifest.entries[0].path) && err.includes("lacks a reason")
      )
    ).toBe(true);
  });

  test("Scenario 5: jest.config.js resolved config testPathIgnorePatterns contains manifest entries", async () => {
    const jestConfigFn = require("../jest.config.js");
    const resolved = await jestConfigFn();
    expect(resolved.testPathIgnorePatterns).toBeDefined();

    for (const entry of manifest.entries) {
      const escaped = `<rootDir>/${entry.path.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}`;
      expect(resolved.testPathIgnorePatterns).toContain(escaped);
    }
  });

  test("Scenario 7: fallback when git show origin/main is unavailable", () => {
    // When git show fails or origin/main:jest.quarantine.json doesn't exist, it falls back to in-file max
    const fallbackMax = getBaselineMax("invalid-non-repo-dir", 42);
    expect(fallbackMax).toBe(42);
  });
});
