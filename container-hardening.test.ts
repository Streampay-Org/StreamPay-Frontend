import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import { tmpdir } from 'node:os';
import * as path from 'path';

describe('Container Hardening Verification', () => {
  const dockerfilePath = path.join(__dirname, './Dockerfile');
  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');

  test('Dockerfile should run as non-root user', () => {
    expect(dockerfileContent).toContain('USER streampay');
    expect(dockerfileContent).toContain('adduser --system --uid 1001 streampay');
  });

  test('Dockerfile should use multi-stage build for minimal size', () => {
    const stageCount = (dockerfileContent.match(/^FROM /gm) || []).length;
    expect(stageCount).toBeGreaterThanOrEqual(3);
  });

  test('Dockerfile should have healthcheck', () => {
    expect(dockerfileContent).toContain('HEALTHCHECK');
    expect(dockerfileContent).toContain('/api/readyz');
  });

  test('worker runner should have a heartbeat healthcheck', () => {
    const workerStage = dockerfileContent.split(/^FROM node:20-alpine AS worker-runner\s*$/m)[1] ?? '';

    expect(workerStage).toMatch(/HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3/);
    expect(workerStage).toContain('WORKER_HEARTBEAT_FILE');
    expect(workerStage).toContain('300000');
  });

  test('worker heartbeat healthcheck rejects a stale heartbeat', () => {
    const workerStage = dockerfileContent.split(/^FROM node:20-alpine AS worker-runner\s*$/m)[1] ?? '';
    const healthcheckScript = workerStage.match(/CMD node -e "([^"]+)"/)?.[1];
    if (!healthcheckScript) {
      throw new Error('Worker healthcheck command is missing');
    }

    const temporaryDirectory = fs.mkdtempSync(path.join(tmpdir(), 'worker-healthcheck-'));
    const heartbeatFile = path.join(temporaryDirectory, 'heartbeat');

    try {
      fs.writeFileSync(heartbeatFile, '');
      execFileSync(process.execPath, ['-e', healthcheckScript], {
        env: { ...process.env, WORKER_HEARTBEAT_FILE: heartbeatFile },
      });

      const staleTime = new Date(Date.now() - 300001);
      fs.utimesSync(heartbeatFile, staleTime, staleTime);
      expect(() => execFileSync(process.execPath, ['-e', healthcheckScript], {
        env: { ...process.env, WORKER_HEARTBEAT_FILE: heartbeatFile },
      })).toThrow();
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('Next.js should be configured for standalone output', () => {
    const nextConfigPath = path.join(__dirname, './next.config.ts');
    const nextConfigContent = fs.readFileSync(nextConfigPath, 'utf8');
    expect(nextConfigContent).toContain("output: 'standalone'");
  });

  test('K8s security documentation should exist', () => {
    const k8sDocsPath = path.join(__dirname, './docs/k8s-security.md');
    expect(fs.existsSync(k8sDocsPath)).toBe(true);
    
    const k8sDocsContent = fs.readFileSync(k8sDocsPath, 'utf8');
    expect(k8sDocsContent).toContain('runAsNonRoot: true');
    expect(k8sDocsContent).toContain('readOnlyRootFilesystem: true');
    expect(k8sDocsContent).toContain('drop:');
    expect(k8sDocsContent).toContain('- ALL');
  });

  // ── Worker-runner image hardening (issue #2006) ───────────────────────────

  test('worker-runner stage does not use COPY . .', () => {
    // Extract only the worker-runner stage content.
    const workerStageMatch = dockerfileContent.match(
      /FROM .+ AS worker-runner([\s\S]*?)(?=^\s*FROM |\s*$)/m,
    );
    const workerStage = workerStageMatch ? workerStageMatch[1] : '';
    expect(workerStage).not.toContain('COPY . .');
  });

  test('worker-runner stage does not copy dev-only paths', () => {
    const devOnlyPaths = ['contracts', 'tests', '__tests__', 'docs', 'design', 'spike', 'coverage'];
    const workerStageMatch = dockerfileContent.match(
      /FROM .+ AS worker-runner([\s\S]*?)(?=^\s*FROM |\s*$)/m,
    );
    const workerStage = workerStageMatch ? workerStageMatch[1] : '';
    for (const devPath of devOnlyPaths) {
      expect(workerStage).not.toContain(`COPY ${devPath}`);
      expect(workerStage).not.toContain(`COPY ./${devPath}`);
    }
  });

  test('worker-runner uses a dedicated worker-deps stage (not the full deps stage)', () => {
    expect(dockerfileContent).toContain('AS worker-deps');
    const workerStageMatch = dockerfileContent.match(
      /FROM .+ AS worker-runner([\s\S]*?)(?=^\s*FROM |\s*$)/m,
    );
    const workerStage = workerStageMatch ? workerStageMatch[1] : '';
    expect(workerStage).toContain('worker-deps');
    expect(workerStage).not.toMatch(/COPY --from=deps/);
  });

  test('worker-deps stage installs ts-node and typescript after pruning devDeps', () => {
    const workerDepsMatch = dockerfileContent.match(
      /FROM .+ AS worker-deps([\s\S]*?)(?=^\s*FROM |\s*$)/m,
    );
    const workerDepsStage = workerDepsMatch ? workerDepsMatch[1] : '';
    expect(workerDepsStage).toContain('--omit=dev');
    expect(workerDepsStage).toContain('ts-node');
    expect(workerDepsStage).toContain('typescript');
  });

  test('.dockerignore exists and excludes key dev paths', () => {
    const ignorePath = path.join(__dirname, './.dockerignore');
    expect(fs.existsSync(ignorePath)).toBe(true);
    const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
    for (const entry of ['contracts', 'tests', 'docs', 'node_modules', '.git']) {
      expect(ignoreContent).toContain(entry);
    }
  });
});
