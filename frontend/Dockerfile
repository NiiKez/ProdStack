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
# Hardening history: M3 moved off floating `nginx:alpine` → minor-pinned
# `nginx:1.27-alpine`, digest-pinned to an immutable @sha256. Then (2026-06-12,
# off the back of the Trivy image scan) switched to the FULLY-ROOTLESS
# `nginxinc/nginx-unprivileged` (first 1.29-alpine; Dependabot has since rolled
# the tag forward — currently 1.31-alpine, PR #27/#42):
#   1. Security: stock nginx runs its master process as root (only to bind the
#      privileged port :80). The unprivileged image runs the whole stack as uid
#      101 and listens on :8080 — clears Trivy AVD-DS-0002 (run-as-root HIGH).
#   2. Freshness: `nginx:1.27-alpine` was stuck on alpine 3.21.3 and had
#      accumulated 32 HIGH/CRITICAL OS CVEs; the nginx-unprivileged alpine line
#      (3.23.x+) is down to ~3 HIGH, the rest unfixed-upstream.
# Listening on :8080 (not :80) REQUIRES the web Container App's ingress
# targetPort to be 8080 — done live + made durable in infra/provision-prodstack-web.sh.
# It still ships the same envsubst entrypoint (/docker-entrypoint.d/...) so the
# /etc/nginx/templates/*.template render below is unchanged.
# The digest below is for nginxinc/nginx-unprivileged:1.31-alpine (Dependabot
# keeps the tag + digest current; update both together, never the tag alone).
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:a8d5564c3354241473c1e152d5dd3281ab4224edb61b23c291e0bfd9854687a1 AS runner

# Install our site config as an envsubst TEMPLATE. nginx:alpine's
# /docker-entrypoint.d/20-envsubst-on-templates.sh renders every
# /etc/nginx/templates/*.template to /etc/nginx/conf.d/<name w/o .template> at
# container start, so this becomes /etc/nginx/conf.d/default.conf — overwriting
# the stock default site — with ${BACKEND_FQDN} substituted from the env var of
# the same name (set on the web Container App). See frontend/nginx.conf.template.
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

# Default EDGE_PROXY_SECRET to empty so the nginx entrypoint's envsubst ALWAYS
# has a value to substitute for the ${EDGE_PROXY_SECRET} references in the
# template (the `proxy_set_header X-ProdStack-Edge` lines). Without this default
# the var is undefined at render time, envsubst leaves the literal
# `${EDGE_PROXY_SECRET}`, and nginx then treats it as an unknown *runtime*
# variable and refuses to start (`[emerg] unknown "edge_proxy_secret" variable`)
# — so the marker was NOT "inert when unset" as the template comment claims; it
# crash-looped the container, silently wedging every web roll on the last good
# revision. With the empty default the header renders as "" (the API ignores an
# empty/non-matching value and keys its limiters on req.ip as before), and a real
# value set on the web Container App still OVERRIDES this to activate the
# rate-limit-integrity check. See frontend/nginx.conf.template + the env-contract
# note in CLAUDE.md + backend/src/middleware/rateLimit.ts.
ENV EDGE_PROXY_SECRET=""

# Security response headers, included by the site config at both the server level
# and inside the locations that set their own add_header (which would otherwise
# stop nginx from inheriting these). See frontend/nginx.security-headers.conf and
# the H1 review finding. Not a .template — no env-var substitution needed.
COPY frontend/nginx.security-headers.conf /etc/nginx/snippets/prodstack-security-headers.conf

# Static SPA bundle.
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Run as the unprivileged uid the base image ships (101 = nginx). The base
# already defaults to this; we restate it explicitly so Trivy's Dockerfile scan
# (AVD-DS-0002), which does not resolve the base image's USER, also passes.
# COPY above runs at build time as root regardless, so file placement is fine.
USER 101

EXPOSE 8080

# Lightweight liveness probe against the SPA shell (no backend dependency).
# Port matches the unprivileged image's :8080 listen (see nginx.conf.template).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

# The unprivileged base image's default CMD already runs `nginx -g 'daemon off;'`.
