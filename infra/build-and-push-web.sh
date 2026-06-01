#!/usr/bin/env bash
# Build the prodstack-web frontend image and push to ACR.
#
# Usage: ./infra/build-and-push-web.sh <tag>
#   e.g. ./infra/build-and-push-web.sh m5-rev1   (default: m5-rev1)
#
# Mirrors the prodstack-api / prodstack-builder push flow: docker build with the
# repo ROOT as context (frontend/Dockerfile needs the monorepo lockfile + both
# workspace package.json files for the npm workspace install), tag for ACR,
# docker login with admin creds, push.
#
# The image is an nginx container that serves the built Vite SPA AND
# reverse-proxies /api + /builds to prodstack-api (see frontend/nginx.conf), so
# the browser stays same-origin. No API URL is baked into the build — env.ts
# defaults VITE_API_BASE_URL to '' (same-origin) and nginx does the proxying.
#
# Prereqs: docker running, az CLI logged in (for `az acr credential show`).

set -euo pipefail

cd "$(dirname "$0")/.."

ACR=prodstack
ACR_LOGIN_SERVER=prodstack.azurecr.io
IMAGE=prodstack-web

TAG="${1:-m5-rev1}"

echo "Building ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG} (context = repo root) ..."
docker build -t "${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}" -f frontend/Dockerfile .

echo "Logging in to ACR ${ACR} ..."
ACR_USER=$(az acr credential show --name "${ACR}" --query username -o tsv)
ACR_PASS=$(az acr credential show --name "${ACR}" --query "passwords[0].value" -o tsv)
echo "${ACR_PASS}" | docker login "${ACR_LOGIN_SERVER}" -u "${ACR_USER}" --password-stdin

echo "Pushing ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG} ..."
docker push "${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}"

echo "Done. Roll the revision with:"
echo "  bash infra/provision-prodstack-web.sh ${TAG}"
echo "or directly:"
echo "  az containerapp update -n prodstack-web -g prodstack --image ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}"
