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
});
