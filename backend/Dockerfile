# Multi-stage build for the ProdStack API.
#
# Build context: the monorepo root (so we can use the workspace lockfile).
# Invoked as: `docker build -f backend/Dockerfile .` or via `az acr build`
# with `--file backend/Dockerfile <root>`.

# syntax=docker/dockerfile:1.7

# --- Builder --------------------------------------------------------------
FROM node:20-alpine AS builder
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
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# tini reaps zombies and forwards SIGTERM cleanly so Container Apps' graceful
# shutdown doesn't have to wait for the 30s SIGKILL fallback.
RUN apk add --no-cache tini

# npm workspaces hoist every dep to the root node_modules; there's no
# per-workspace folder. Running from /app means Node's module resolution
# finds @prisma/client and friends via the standard walk-up.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/prisma ./backend/prisma
COPY --from=builder /app/backend/package.json ./backend/package.json

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/dist/index.js"]
