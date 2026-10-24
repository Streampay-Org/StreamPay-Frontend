import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Environment Variable Inventory & Documentation Parity Test
 *
 * Verifies that:
 * 1. Every process.env read across app/, lib/, src/, and middleware.ts is documented in .env.example.
 * 2. Every documented variable in .env.example includes Required and Default annotations.
 * 3. Every documented variable in .env.example is typed in global.d.ts (NodeJS.ProcessEnv).
 * 4. Undocumented env reads are reliably flagged.
 */

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');
const GLOBAL_DTS_PATH = path.join(ROOT_DIR, 'global.d.ts');

/**
 * Parse .env.example and extract all declared environment variable names.
 */
export function extractDocEnvVars(filePath: string = ENV_EXAMPLE_PATH): Set<string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const vars = new Set<string>();

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match lines starting with VAR_NAME= (ignore commented lines like # FOO=bar)
    const match = trimmed.match(/^([A-Z0-9_]+)=/);
    if (match) {
      vars.add(match[1]);
    }
  }

  return vars;
}

/**
 * Parse global.d.ts and extract all environment variable keys from NodeJS.ProcessEnv.
 */
export function extractProcessEnvTypes(filePath: string = GLOBAL_DTS_PATH): Set<string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const vars = new Set<string>();

  const processEnvMatch = content.match(/interface\s+ProcessEnv\s*\{([\s\S]*?)\}/);
  if (!processEnvMatch) {
    throw new Error('Could not find interface ProcessEnv in global.d.ts');
  }

  const block = processEnvMatch[1];
  const fieldMatches = block.matchAll(/^\s*([A-Z0-9_]+)\??\s*:/gm);
  for (const m of fieldMatches) {
    vars.add(m[1]);
  }

  return vars;
}

/**
 * Remove line and block comments while preserving comments that appear inside
 * string/template literals. This keeps the scanner from treating commented-out
 * env reads (or prose in JSDoc) as real configuration dependencies.
 */
export function stripComments(source: string): string {
  type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block';
  let state: State = 'code';
  let result = '';

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    switch (state) {
      case 'code':
        if (char === '/' && next === '/') {
          state = 'line';
          i++;
        } else if (char === '/' && next === '*') {
          state = 'block';
          i++;
        } else {
          result += char;
          if (char === "'") state = 'single';
          else if (char === '"') state = 'double';
          else if (char === '`') state = 'template';
        }
        break;

      case 'single':
      case 'double':
      case 'template': {
        result += char;
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (char === '\\') {
          if (next !== undefined) {
            result += next;
            i++;
          }
        } else if (char === quote) {
          state = 'code';
        }
        break;
      }

      case 'line':
        // Preserve the newline so line numbers / token boundaries stay sane.
        if (char === '\n') {
          result += char;
          state = 'code';
        }
        break;

      case 'block':
        if (char === '*' && next === '/') {
          i++;
          state = 'code';
        } else if (char === '\n') {
          result += char;
        }
        break;
    }
  }

  return result;
}

/**
 * Scan source files across app/, lib/, src/, and middleware.ts for process.env reads.
 * Returns a map of variable name -> array of relative file paths where read.
 *
 * Test/spec/mock files and comments are ignored so the result reflects only
 * runtime configuration dependencies.
 */
export function scanSourceFilesForEnvVars(
  baseDir: string = ROOT_DIR,
  targetDirs: string[] = ['app', 'lib', 'src'],
  singleFiles: string[] = ['middleware.ts']
): Map<string, string[]> {
  const envReads = new Map<string, string[]>();

  const propPattern = /process\.env\.([A-Za-z0-9_]+)/g;
  const bracketPattern = /process\.env\[['"]([A-Za-z0-9_]+)['"]\]/g;
  const destructPattern = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;
  const helperPattern = /(?:sseEnvNumber|resolveMaxBodyBytes)\(['"]([A-Za-z0-9_]+)['"]/g;
  const envPropPattern = /\benv\.([A-Z0-9_]+)\b/g;

  function record(varName: string, relPath: string) {
    if (!envReads.has(varName)) {
      envReads.set(varName, []);
    }
    const list = envReads.get(varName)!;
    if (!list.includes(relPath)) {
      list.push(relPath);
    }
  }

  function scanFile(filePath: string) {
    const relPath = path.relative(baseDir, filePath);
    const normalizedPath = relPath.split(path.sep).join('/');
    // Ignore test files, specs, and mocks in any directory.
    if (
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalizedPath) ||
      /(^|\/)(__tests__|__mocks__)(\/|$)/.test(normalizedPath)
    ) {
      return;
    }

    const content = stripComments(fs.readFileSync(filePath, 'utf-8'));

    for (const m of content.matchAll(propPattern)) {
      record(m[1], relPath);
    }

    for (const m of content.matchAll(bracketPattern)) {
      record(m[1], relPath);
    }

    for (const m of content.matchAll(helperPattern)) {
      record(m[1], relPath);
    }

    for (const m of content.matchAll(destructPattern)) {
      const destructured = m[1].split(',');
      for (const item of destructured) {
        const key = item.trim().split(':')[0].trim();
        if (key && /^[A-Z0-9_]+$/.test(key)) {
          record(key, relPath);
        }
      }
    }

    // Handlers that alias process.env as `env`
    if (relPath.includes('config/index.ts') || relPath.includes('chaos.ts')) {
      for (const m of content.matchAll(envPropPattern)) {
        record(m[1], relPath);
      }
    }
  }

  function walkDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.next', '.git', '.dist', '.swc'].includes(entry.name)) {
          walkDir(fullPath);
        }
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        scanFile(fullPath);
      }
    }
  }

  for (const d of targetDirs) {
    walkDir(path.join(baseDir, d));
  }

  for (const sf of singleFiles) {
    const p = path.join(baseDir, sf);
    if (fs.existsSync(p)) {
      scanFile(p);
    }
  }

  return envReads;
}

/**
 * Validate that each variable block in .env.example includes Required and Default annotations.
 */
export function validateEnvExampleDocumentation(filePath: string = ENV_EXAMPLE_PATH): {
  valid: boolean;
  missingAnnotations: Record<string, string[]>;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const missingAnnotations: Record<string, string[]> = {};

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([A-Z0-9_]+)=/);
    if (match) {
      const varName = match[1];
      const commentBlock: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prevLine = lines[j].trim();
        if (prevLine.startsWith('#')) {
          commentBlock.unshift(prevLine);
        } else {
          break;
        }
      }

      const commentText = commentBlock.join('\n');
      const issues: string[] = [];

      if (!/Required:\s*(Yes|No)/i.test(commentText)) {
        issues.push('Missing "Required: Yes/No" annotation');
      }
      if (!/Default:\s*/i.test(commentText)) {
        issues.push('Missing "Default: ..." annotation');
      }

      if (issues.length > 0) {
        missingAnnotations[varName] = issues;
      }
    }
  }

  return {
    valid: Object.keys(missingAnnotations).length === 0,
    missingAnnotations,
  };
}

describe('Environment Variable Inventory & Documentation (Issue #1635)', () => {
  it('should ensure every environment variable read in source code is documented in .env.example', () => {
    const documentedVars = extractDocEnvVars(ENV_EXAMPLE_PATH);
    const sourceEnvReads = scanSourceFilesForEnvVars();

    const undocumentedVars: Array<{ variable: string; files: string[] }> = [];

    Array.from(sourceEnvReads.entries()).forEach(([varName, files]) => {
      if (!documentedVars.has(varName)) {
        undocumentedVars.push({ variable: varName, files });
      }
    });

    if (undocumentedVars.length > 0) {
      const formatted = undocumentedVars
        .map((u) => `  - ${u.variable} (read in: ${u.files.join(', ')})`)
        .join('\n');
      throw new Error(
        `Found ${undocumentedVars.length} undocumented environment variable(s) read in source code:\n${formatted}\n\nPlease document them in .env.example and global.d.ts.`
      );
    }

    expect(undocumentedVars).toEqual([]);
    expect(documentedVars.size).toBeGreaterThanOrEqual(sourceEnvReads.size);
  });

  it('should ensure each entry in .env.example states Required and Default status', () => {
    const { valid, missingAnnotations } = validateEnvExampleDocumentation(ENV_EXAMPLE_PATH);

    if (!valid) {
      const formatted = Object.entries(missingAnnotations)
        .map(([v, issues]) => `  - ${v}: ${issues.join('; ')}`)
        .join('\n');
      throw new Error(
        `The following variables in .env.example are missing required documentation comments:\n${formatted}`
      );
    }

    expect(valid).toBe(true);
  });

  it('should ensure global.d.ts ProcessEnv matches .env.example list', () => {
    const documentedVars = extractDocEnvVars(ENV_EXAMPLE_PATH);
    const typedVars = extractProcessEnvTypes(GLOBAL_DTS_PATH);

    const missingInTypes: string[] = [];
    Array.from(documentedVars).forEach((v) => {
      if (!typedVars.has(v)) {
        missingInTypes.push(v);
      }
    });

    if (missingInTypes.length > 0) {
      throw new Error(
        `The following variables from .env.example are missing from global.d.ts ProcessEnv:\n` +
          missingInTypes.map((v) => `  - ${v}`).join('\n')
      );
    }

    expect(missingInTypes).toEqual([]);
  });

  it('should detect undocumented env reads in a fixture source file and name them', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streampay-env-fixture-'));
    try {
      const appDir = path.join(fixtureRoot, 'app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, 'secret.ts'),
        [
          'const documented = process.env.EXISTING_VAR_A;',
          'const undocumented = process.env.NEW_UNDOCUMENTED_SECRET;',
          'export { documented, undocumented };',
        ].join('\n')
      );

      const documentedVars = new Set(['EXISTING_VAR_A']);
      const scannedVars = scanSourceFilesForEnvVars(fixtureRoot, ['app'], []);
      const undocumented = Array.from(scannedVars.keys()).filter(
        (variable) => !documentedVars.has(variable)
      );

      expect(undocumented).toEqual(['NEW_UNDOCUMENTED_SECRET']);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('should ignore test/spec files and comments while scanning', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streampay-env-scan-'));
    try {
      const appDir = path.join(fixtureRoot, 'app');
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, 'real.ts'),
        [
          '// process.env.COMMENTED_LINE',
          '/* process.env.COMMENTED_BLOCK',
          '   process.env.ALSO_COMMENTED */',
          'const url = "https://example.com//path";',
          'const one = process.env.REAL_DOCUMENTED;',
          'const two = process.env["REAL_BRACKET"];',
          'export { url, one, two };',
        ].join('\n')
      );
      fs.writeFileSync(path.join(appDir, 'ignored.test.ts'), 'process.env.TEST_ONLY;');
      fs.writeFileSync(path.join(appDir, 'ignored.spec.ts'), 'process.env.SPEC_ONLY;');
      const nestedTestsDir = path.join(appDir, '__tests__');
      fs.mkdirSync(nestedTestsDir);
      fs.writeFileSync(path.join(nestedTestsDir, 'helper.ts'), 'process.env.NESTED_TEST_ONLY;');

      const scannedVars = scanSourceFilesForEnvVars(fixtureRoot, ['app'], []);

      expect(Array.from(scannedVars.keys()).sort()).toEqual([
        'REAL_BRACKET',
        'REAL_DOCUMENTED',
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
