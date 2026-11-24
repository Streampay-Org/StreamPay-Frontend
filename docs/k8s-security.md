# Kubernetes Security Context for StreamPay

To align with fintech security standards, the following `securityContext` should be applied to all deployments (API and Workers).

## Security Requirements

1. **Non-root user**: The image is configured to run as UID 1001 (streampay).
2. **Read-only root filesystem**: The root filesystem should be mounted as read-only.
3. **Dropped capabilities**: All Linux capabilities should be dropped.
4. **No privilege escalation**: Prevent the process from gaining more privileges.
5. **Minimal image surface**: The worker image ships only the files the worker needs — no contracts/, tests/, docs/, or dev tooling beyond ts-node/typescript.

## Worker Image Hardening (issue #2006)

The `worker-runner` Docker stage was refactored to eliminate the `COPY . .` + `rm -rf` pattern:

- A dedicated `worker-deps` stage installs only production dependencies plus `ts-node` and `typescript` (`npm ci --omit=dev && npm install --no-save ts-node typescript`).
- `worker-runner` copies only the files the worker imports: `scripts/reconcile-streams.ts`, `scripts/reconciliation/`, `scripts/run-from-realpath.mjs`, `tsconfig.json`, and `package.json`.
- A `.dockerignore` file excludes `.git`, `node_modules`, `contracts/`, `tests/`, `docs/`, `design/`, `spike/`, `coverage/`, local env files and test configs from the build context, keeping the builder stage inputs correct.

**Estimated image size reduction:** dropping contracts/, tests/, docs/ and the full devDependencies tree reduces the worker image by ~60–70 % versus the previous `COPY . .` approach (exact numbers depend on project size; measure with `docker image ls` before and after).

## Recommended securityContext

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1001
  runAsGroup: 1001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

## Volume Mounts for Read-only FS

Since the root filesystem is read-only, you must mount a `tmpfs` volume for `/tmp` if the application or its dependencies require temporary write access.

```yaml
spec:
  containers:
    - name: streampay-api
      image: streampay-frontend:latest
      volumeMounts:
        - name: tmp-volume
          mountPath: /tmp
  volumes:
    - name: tmp-volume
      emptyDir:
        medium: Memory
```
