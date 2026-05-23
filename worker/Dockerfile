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
FROM node:20-alpine AS builder
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
# Pinned to match the version `kaniko.ts` documents.
FROM gcr.io/kaniko-project/executor:v1.23.2 AS kaniko

# --- Runtime --------------------------------------------------------------
FROM node:20-alpine AS runner
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
