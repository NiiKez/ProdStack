# Multi-stage build for the ProdStack frontend (prodstack-web).
#
# Build context: the monorepo ROOT (so we can use the workspace lockfile and
# both workspaces' package.json files — npm workspaces hoist everything to the
# root node_modules, so a frontend-only context can't resolve deps).
# Invoked as: `docker build -f frontend/Dockerfile -t prodstack.azurecr.io/prodstack-web:<tag> .`
# from the repo root (see infra/build-and-push-web.sh).
#
# Runner is nginx, which serves the built SPA AND reverse-proxies /api + /builds
# to the backend Container App so the browser only ever talks to the
# prodstack-web origin (same-origin cookies + SSE). See frontend/nginx.conf.template.
#
# NOTE: the API base URL is intentionally NOT baked in. frontend/src/env.ts
# defaults VITE_API_BASE_URL to '' (same-origin), and nginx proxies the API
# paths, so no build arg is needed — leaving it unset is correct.

# syntax=docker/dockerfile:1.7

# --- Builder --------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps with the workspace lockfile. Copy only manifests first so this
# layer caches across source changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --no-audit --no-fund

# Build the frontend workspace → frontend/dist (vite's default outDir).
COPY frontend ./frontend
RUN npm run build --workspace=@prodstack/web

# --- Runtime --------------------------------------------------------------
FROM nginx:alpine AS runner

# Install our site config as an envsubst TEMPLATE. nginx:alpine's
# /docker-entrypoint.d/20-envsubst-on-templates.sh renders every
# /etc/nginx/templates/*.template to /etc/nginx/conf.d/<name w/o .template> at
# container start, so this becomes /etc/nginx/conf.d/default.conf — overwriting
# the stock default site — with ${BACKEND_FQDN} substituted from the env var of
# the same name (set on the web Container App). See frontend/nginx.conf.template.
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

# Static SPA bundle.
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

# Lightweight liveness probe against the SPA shell (no backend dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
