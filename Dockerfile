# Stage 1: Dependencies (all — used by builder)
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Worker dependencies
# Install production deps, then layer in only the TypeScript tooling the
# worker needs to run ts-node.  This avoids shipping the full devDependencies
# tree while still being able to execute the worker's TypeScript source.
FROM node:20-alpine AS worker-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install --no-save ts-node typescript

# Stage 4: API Runner (Default target)
FROM node:20-alpine AS api-runner
WORKDIR /app

ENV NODE_ENV production

# Hardening: Run as non-root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 streampay

# Hardening: Minimal set of files using Next.js standalone
COPY --from=builder /app/public ./public
COPY --from=builder --chown=streampay:nodejs /app/.next/standalone ./
COPY --from=builder --chown=streampay:nodejs /app/.next/static ./.next/static

USER streampay

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Healthcheck to verify app is running
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/readyz || exit 1

CMD ["node", "server.js"]

# Stage 5: Worker Runner
# Only the worker's source files are copied — no COPY . . and no rm -rf workaround.
FROM node:20-alpine AS worker-runner
WORKDIR /app

ENV NODE_ENV production

# Hardening: Run as non-root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 streampay

# Production + ts-node/typescript only (no other devDependencies)
COPY --from=worker-deps /app/node_modules ./node_modules

# Only the files the worker actually needs
COPY package.json tsconfig.json ./
COPY scripts/run-from-realpath.mjs ./scripts/run-from-realpath.mjs
COPY scripts/reconcile-streams.ts ./scripts/reconcile-streams.ts
COPY scripts/reconciliation/ ./scripts/reconciliation/

USER streampay

# Worker command — behaviour unchanged
CMD ["node", "scripts/run-from-realpath.mjs", "ts-node", "scripts/reconcile-streams.ts"]
