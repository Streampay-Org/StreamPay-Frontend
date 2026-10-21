import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Count TypeScript diagnostics once each, grouped by their top-level directory. */
export function countDiagnostics(output) {
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(?:(.+)\(\d+,\d+\): )?error TS\d+:/);
    if (!match) continue;
    const file = match[1]?.replaceAll('\\', '/').replace(/^\.\//, '');
    const directory = !file ? '(config)' : file.includes('/') ? file.split('/')[0] : '(root)';
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return counts;
}

/** Print full-project debt without making existing diagnostics a failing gate. */
export function report() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '--project', 'tsconfig.json', '--noEmit', '--pretty', 'false', '--incremental', 'false'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TypeScript terminated by ${result.signal}`);
  const output = result.stdout + result.stderr;
  const counts = countDiagnostics(output);
  if (result.status !== 0 && counts.size === 0) throw new Error(output || `TypeScript exited ${result.status}`);
  console.log('Full-project type errors (informational; typecheck:core is the blocking gate)');
  console.log('| Directory | Errors |\n| --- | ---: |');
  let total = 0;
  for (const [directory, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`| ${directory} | ${count} |`);
    total += count;
  }
  console.log(`| Total | ${total} |`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) report();
