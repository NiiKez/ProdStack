# Multi-stage build for the ProdStack API.
#
# Build context: the monorepo root (so we can use the workspace lockfile).
# Invoked as: `docker build -f backend/Dockerfile .` or via `az acr build`
# with `--file backend/Dockerfile <root>`.

# syntax=docker/dockerfile:1.7

# --- Builder --------------------------------------------------------------
# Base image digest-pinned (M3 hardening): immutable @sha256 so a retagged
# upstream can't silently change the build. The digest is for node:20-alpine.
FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS builder
WORKDIR /app

# Install deps with the workspace lockfile. Copy only manifests first so
# this layer caches across source changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --no-audit --no-fund

# Generate the Prisma client (needs the schema, no live DB).
COPY backend/prisma ./backend/prisma
RUN npm run prisma:generate --workspace=@prodstack/api

# Compile TypeScript.
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN npm run build --workspace=@prodstack/api

# Strip dev deps from the workspace. The generated Prisma client lives
# under node_modules/.prisma/* and survives prune because @prisma/client
# is a runtime dependency.
RUN npm prune --omit=dev

# --- Runtime --------------------------------------------------------------
# Base image digest-pinned (M3 hardening) — node:20-alpine; see builder note.
FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# tini reaps zombies and forwards SIGTERM cleanly so Container Apps' graceful
# shutdown doesn't have to wait for the 30s SIGKILL fallback. openssl is
# required by the Prisma schema/migration engine the entrypoint invokes
# (`prisma migrate deploy`) — the query engine already runs here, but the
# migration engine needs libssl present on Alpine/musl.
RUN apk add --no-cache tini openssl

# npm workspaces hoist every dep to the root node_modules; there's no
# per-workspace folder. Running from /app means Node's module resolution
# finds @prisma/client and friends via the standard walk-up. `prisma` is a
# runtime dependency (not pruned) so `prisma migrate deploy` works here.
#
# M2 hardening: run as the built-in non-root `node` user (uid 1000, shipped by
# node:*-alpine). Every copied artifact is --chown=node:node so the non-root
# runtime can READ what it needs — node_modules (incl. the Prisma client + engine
# binaries under node_modules/.prisma) and the migrations dir. The entrypoint's
# `prisma migrate deploy` takes an in-DB Postgres advisory lock (see
# docker-entrypoint.sh), not a filesystem lock — it writes nothing under /app at
# runtime. The app binds :3000 (>1024) so no root privilege is required for the
# listen socket.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/backend/dist ./backend/dist
COPY --from=builder --chown=node:node /app/backend/prisma ./backend/prisma
COPY --from=builder --chown=node:node /app/backend/package.json ./backend/package.json

# Entrypoint runs `prisma migrate deploy` on boot, then execs the CMD. See the
# script header for why migrations run here and not in the GitHub workflow.
COPY --chown=node:node backend/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# `WORKDIR /app` created /app as root:root; the COPY --chown only chowned the
# contents, not the directory itself. Make the cwd node-owned so any future code
# (a temp file, crash dump, or a Prisma version that writes relative to cwd) can't
# EACCES-crash-loop the non-root container.
RUN chown node:node /app

# Drop root: everything below (entrypoint migrate + node server) runs as `node`.
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "backend/dist/index.js"]
