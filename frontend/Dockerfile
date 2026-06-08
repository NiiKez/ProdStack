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
# Base image digest-pinned (M3 hardening): immutable @sha256 so a retagged
# upstream can't silently change the build. The digest is for node:20-alpine.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
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
# M3 hardening: moved off the floating `nginx:alpine` to a minor-pinned
# `nginx:1.27-alpine`, then digest-pinned to an immutable @sha256.
#
# M2 hardening note — nginx is NOT switched to a fully-rootless image in this
# pass (deliberate deferral): stock nginx already runs its WORKER processes
# (which handle every request) as the unprivileged `nginx` user; only the
# master process is root, solely to bind the privileged port :80. So request
# handling is already non-root. A fully-rootless master (nginx-unprivileged)
# listens on :8080 instead of :80, which would REQUIRE a coordinated, one-time
# `az containerapp ingress update -n prodstack-web -g prodstack --target-port 8080`
# BEFORE the next CI roll — otherwise the revision fails activation (ingress
# targetPort 80 vs listen 8080). That deploy-coupling is intentionally left as
# a follow-up; prodstack-web is in the CI auto-deploy allow-list.
# The digest below is for nginx:1.27-alpine.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runner

# Install our site config as an envsubst TEMPLATE. nginx:alpine's
# /docker-entrypoint.d/20-envsubst-on-templates.sh renders every
# /etc/nginx/templates/*.template to /etc/nginx/conf.d/<name w/o .template> at
# container start, so this becomes /etc/nginx/conf.d/default.conf — overwriting
# the stock default site — with ${BACKEND_FQDN} substituted from the env var of
# the same name (set on the web Container App). See frontend/nginx.conf.template.
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

# Security response headers, included by the site config at both the server level
# and inside the locations that set their own add_header (which would otherwise
# stop nginx from inheriting these). See frontend/nginx.security-headers.conf and
# the H1 review finding. Not a .template — no env-var substitution needed.
COPY frontend/nginx.security-headers.conf /etc/nginx/snippets/prodstack-security-headers.conf

# Static SPA bundle.
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

# Lightweight liveness probe against the SPA shell (no backend dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
