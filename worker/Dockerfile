# Multi-stage build for the prodstack-builder worker.
#
# Build context: the monorepo root (same as backend/Dockerfile).
# Invoked as: `docker build -f worker/Dockerfile -t prodstack.azurecr.io/prodstack-builder:<tag> .`
#
# The worker shares the backend source tree (so it imports the same Prisma
# client, env validation, Azure SDK wrappers, etc.) but ships under a
# different entrypoint (`backend/dist/worker.js`) and bundles the kaniko
# binary + git so it can clone repos and build images in-image.

# syntax=docker/dockerfile:1.7

# --- Builder --------------------------------------------------------------
# Base image digest-pinned (M3 hardening): immutable @sha256 so a retagged
# upstream can't silently change the build. The digest is for node:20-alpine.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --no-audit --no-fund

COPY backend/prisma ./backend/prisma
RUN npm run prisma:generate --workspace=@prodstack/api

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN npm run build --workspace=@prodstack/api

RUN npm prune --omit=dev

# --- Kaniko binary --------------------------------------------------------
# Pulling the official kaniko image just so we can copy its executor out.
# Pinned to match the version `kaniko.ts` documents, and digest-pinned (M3).
# The digest is for gcr.io/kaniko-project/executor:v1.23.2.
FROM gcr.io/kaniko-project/executor:v1.24.0@sha256:4e7a52dd1f14872430652bb3b027405b8dfd17c4538751c620ac005741ef9698 AS kaniko

# --- Runtime --------------------------------------------------------------
# Base image digest-pinned (M3 hardening) — see the builder stage note.
#
# M2 hardening exception — THIS STAGE INTENTIONALLY RUNS AS ROOT (uid 0):
# the worker shells out to `/kaniko/executor`, and kaniko builds container
# images by snapshotting the whole root filesystem in-place (it untars layers,
# chowns/chmods arbitrary paths, and diffs `/` between stages). That requires
# uid 0 — a non-root USER makes kaniko fail with permission errors on the FS
# snapshot. The security reviewer flagged this as the known hard case; we keep
# root here deliberately and explicitly rather than silently. Mitigations: the
# builder has no ingress (unreachable from the internet), runs as a single
# isolated Container App, and its inputs are git-arg-validated (see
# docs/BUILD_PIPELINE.md §"Security: git argument-injection hardening").
# A future rootless build engine (e.g. buildkit-rootless / kaniko user-ns) is
# the only way to drop this; not in scope for this pass.
# Base image digest-pinned (M3 hardening) — node:20-alpine; see builder note.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV BUILD_RUNNER_MODE=kaniko
ENV ENABLE_WORKER=true
ENV BUILD_WORK_DIR=/var/builds

# tini for clean SIGTERM forwarding; git for repo cloning; ca-certificates
# so kaniko can speak HTTPS to ACR.
RUN apk add --no-cache tini git ca-certificates \
    && mkdir -p /var/builds /kaniko \
    && chmod 700 /var/builds

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/prisma ./backend/prisma
COPY --from=builder /app/backend/package.json ./backend/package.json

# Kaniko binary + its bundled root certs. `/kaniko/executor` is what
# `BUILD_RUNNER_MODE=kaniko` invokes in `kaniko.ts`.
COPY --from=kaniko /kaniko /kaniko
ENV PATH="/kaniko:${PATH}"
ENV SSL_CERT_DIR=/kaniko/ssl/certs

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/dist/worker.js"]
